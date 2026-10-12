package jobs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type Executor interface {
	Execute(context.Context, Envelope) (json.RawMessage, error)
}
type Publisher func(context.Context, pgx.Tx, Job, json.RawMessage) error
type HTTPExecutor struct {
	endpoint string
	token    string
	client   *http.Client
}

var ErrExecutor = errors.New("executor unavailable")

// The endpoint is operator configuration, never a URL supplied in job payloads.
func NewHTTPExecutor(endpoint, token string, timeout time.Duration) (*HTTPExecutor, error) {
	u, e := url.Parse(endpoint)
	if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Fragment != "" || timeout < time.Second || timeout > 15*time.Minute || strings.ContainsAny(token, "\r\n") {
		return nil, ErrInvalid
	}
	return &HTTPExecutor{endpoint: endpoint, token: token, client: &http.Client{Timeout: timeout, Transport: &http.Transport{Proxy: nil, MaxConnsPerHost: 16, MaxIdleConnsPerHost: 16, ResponseHeaderTimeout: 20 * time.Second, IdleConnTimeout: 60 * time.Second}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (e *HTTPExecutor) Close() { e.client.CloseIdleConnections() }
func (e *HTTPExecutor) Execute(ctx context.Context, envelope Envelope) (json.RawMessage, error) {
	body, err := json.Marshal(envelope)
	if err != nil {
		return nil, ErrInvalid
	}
	req, err := http.NewRequestWithContext(ctx, "POST", e.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, ErrExecutor
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", envelope.JobID)
	if e.token != "" {
		req.Header.Set("Authorization", "Bearer "+e.token)
	}
	response, err := e.client.Do(req)
	if err != nil {
		return nil, ErrExecutor
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") {
		return nil, ErrExecutor
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || !validObject(raw, 1<<20) {
		return nil, ErrInvalid
	}
	return raw, nil
}

// ExecuteLease owns its renewer. Cancellation or failed renewal interrupts the
// executor; success is published only through the still-current durable fence.
func (q *Queue) ExecuteLease(ctx context.Context, l Lease, executor Executor) error {
	return q.ExecuteLeaseWithPublisher(ctx, l, executor, nil)
}

func (q *Queue) ExecuteLeaseWithPublisher(ctx context.Context, l Lease, executor Executor, publisher Publisher) error {
	execution, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{})
	renewErr := make(chan error, 1)
	go func() {
		defer close(done)
		tick := time.NewTicker(q.Config.Lease / 3)
		defer tick.Stop()
		for {
			select {
			case <-execution.Done():
				return
			case <-tick.C:
				check, stop := context.WithTimeout(execution, 2*time.Second)
				e := q.Renew(check, l)
				stop()
				if e != nil {
					renewErr <- e
					cancel()
					return
				}
			}
		}
	}()
	result, err := executor.Execute(execution, l.Envelope())
	cancel()
	<-done
	select {
	case leaseErr := <-renewErr:
		return leaseErr
	default:
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	commit, stop := context.WithTimeout(ctx, 5*time.Second)
	defer stop()
	if err != nil {
		code := "executor_failed"
		if errors.Is(err, ErrInvalid) {
			code = "invalid_result"
		}
		if e := q.Fail(commit, l, code, time.Duration(1<<min(l.Job.Attempt, 8))*time.Second); e != nil {
			return e
		}
		return ErrExecutor
	}
	var publish func(context.Context, pgx.Tx) error
	if publisher != nil {
		publish = func(ctx context.Context, tx pgx.Tx) error { return publisher(ctx, tx, l.Job, result) }
	}
	err = q.Complete(commit, l, result, publish)
	if errors.Is(err, ErrInvalid) {
		if failure := q.Fail(commit, l, "invalid_result", time.Duration(1<<min(l.Job.Attempt, 8))*time.Second); failure != nil {
			return failure
		}
		return ErrExecutor
	}
	return err
}
