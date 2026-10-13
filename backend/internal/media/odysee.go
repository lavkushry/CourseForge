package media

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"courseforge/backend/internal/playback"
	"golang.org/x/sync/singleflight"
)

type Account struct{ Token, Channel string }
type cached struct {
	Target  Target
	Expires time.Time
}
type Odysee struct {
	Accounts []Account
	client   *http.Client
	cache    map[string]cached
	mu       sync.Mutex
	flights  singleflight.Group
	slots    chan struct{}
	now      func() time.Time
	ctx      context.Context
	cancel   context.CancelFunc
	wg       sync.WaitGroup
}

var claimName = regexp.MustCompile(`^[A-Za-z0-9_-]{1,300}$`)
var claimID = regexp.MustCompile(`^[0-9a-fA-F]{40}$`)

func NewOdysee(accounts []Account) *Odysee {
	ctx, cancel := context.WithCancel(context.Background())
	return &Odysee{
		Accounts: accounts,
		client: &http.Client{
			Timeout: 25 * time.Second,
			Transport: &http.Transport{
				Proxy:               nil,
				MaxIdleConns:        64,
				MaxIdleConnsPerHost: 32,
				MaxConnsPerHost:     32,
				IdleConnTimeout:     90 * time.Second,
			},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		cache:  make(map[string]cached),
		slots:  make(chan struct{}, 32),
		now:    time.Now,
		ctx:    ctx,
		cancel: cancel,
	}
}
func (o *Odysee) Close() { o.cancel(); o.client.CloseIdleConnections() }

// Invalidate removes only the failed generation. An older request cannot discard
// a newer source that another caller has already prepared.
func (o *Odysee) Invalidate(source playback.Source, target Target) {
	key := source.ClaimName + ":" + source.ClaimID
	o.mu.Lock()
	defer o.mu.Unlock()
	if value, ok := o.cache[key]; ok && value.Target == target {
		delete(o.cache, key)
	}
}
func (o *Odysee) Resolve(ctx context.Context, source playback.Source) (Target, error) {
	if !claimName.MatchString(source.ClaimName) || !claimID.MatchString(source.ClaimID) || len(o.Accounts) == 0 {
		return Target{}, ErrProvider
	}
	key := source.ClaimName + ":" + source.ClaimID
	o.mu.Lock()
	v, ok := o.cache[key]
	o.mu.Unlock()
	if ok && o.now().Before(v.Expires) {
		return v.Target, nil
	}
	result := o.flights.DoChan(key, func() (any, error) {
		// Independent bounded resolution survives cancellation by one range caller.
		resolveCtx, stop := context.WithTimeout(o.ctx, 60*time.Second)
		defer stop()
		select {
		case o.slots <- struct{}{}:
			defer func() { <-o.slots }()
		case <-time.After(3 * time.Second):
			return Target{}, ErrProvider
		case <-resolveCtx.Done():
			return Target{}, ErrProvider
		}
		for _, account := range o.Accounts {
			if account.Token == "" || account.Channel == "" {
				continue
			}
			target, err := o.resolveAccount(resolveCtx, source, account)
			if err == nil {
				o.mu.Lock()
				if len(o.cache) >= 2048 {
					for k, c := range o.cache {
						if !o.now().Before(c.Expires) {
							delete(o.cache, k)
						}
					}
					if len(o.cache) >= 2048 {
						for k := range o.cache {
							delete(o.cache, k)
							break
						}
					}
				}
				o.cache[key] = cached{target, o.now().Add(30 * time.Minute)}
				o.mu.Unlock()
				return target, nil
			}
			if resolveCtx.Err() != nil {
				break
			}
		}
		return Target{}, ErrProvider
	})
	select {
	case <-ctx.Done():
		return Target{}, ctx.Err()
	case r := <-result:
		if r.Err != nil {
			return Target{}, r.Err
		}
		return r.Val.(Target), nil
	}
}
func (o *Odysee) rpc(ctx context.Context, account Account, method string, params map[string]any) (map[string]any, error) {
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(100*attempt) * time.Millisecond):
			case <-ctx.Done():
				return nil, ErrProvider
			}
		}
		body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
		req, err := http.NewRequestWithContext(ctx, "POST", "https://api.na-backend.odysee.com/api/v1/proxy?m="+method, strings.NewReader(string(body)))
		if err != nil {
			return nil, ErrProvider
		}
		req.Header.Set("X-Lbry-Auth-Token", account.Token)
		req.Header.Set("Content-Type", "application/json")
		response, err := o.client.Do(req)
		if err != nil {
			if attempt < 2 {
				continue
			}
			return nil, ErrProvider
		}
		var data struct {
			Result map[string]any `json:"result"`
			Error  *struct {
				Data map[string]any `json:"data"`
			} `json:"error"`
		}
		d := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
		d.UseNumber()
		err = d.Decode(&data)
		response.Body.Close()
		if response.StatusCode != 200 || err != nil {
			if attempt < 2 {
				continue
			}
			return nil, ErrProvider
		}
		if data.Error == nil && data.Result != nil {
			return data.Result, nil
		}
		if attempt == 0 && method != "status" && data.Error != nil && data.Error.Data != nil && data.Error.Data["name"] == "ComponentsNotStartedError" {
			if _, err = o.rpc(ctx, account, "status", map[string]any{}); err == nil {
				continue
			}
		}
		return nil, ErrProvider
	}
	return nil, ErrProvider
}
func (o *Odysee) resolveAccount(ctx context.Context, source playback.Source, account Account) (Target, error) {
	signed, err := o.rpc(ctx, account, "channel_sign", map[string]any{"channel_id": account.Channel, "hexdata": hex.EncodeToString([]byte(source.ClaimID))})
	if err != nil {
		return Target{}, err
	}
	sig, _ := signed["signature"].(string)
	ts := fmt.Sprint(signed["signing_ts"])
	if sig == "" || ts == "<nil>" {
		return Target{}, ErrProvider
	}
	params := map[string]any{"uri": "lbry://" + source.ClaimName + "#" + source.ClaimID, "signature": sig, "signature_ts": ts}
	resolved, err := o.rpc(ctx, account, "get", params)
	if err != nil {
		return Target{}, err
	}
	raw, _ := resolved["streaming_url"].(string)
	ref := "https://odysee.com/$/embed/" + url.PathEscape(source.ClaimName) + "/" + url.PathEscape(source.ClaimID) + "?" + url.Values{"signature": {sig}, "signature_ts": {ts}}.Encode()
	target := Target{URL: raw, Referer: ref}
	validator := &Gateway{}
	for hop := 0; hop < 4; hop++ {
		if !validator.valid(target.URL) {
			return Target{}, ErrProvider
		}
		req, err := http.NewRequestWithContext(ctx, "HEAD", target.URL, nil)
		if err != nil {
			return Target{}, ErrProvider
		}
		req.Header.Set("Referer", ref)
		req.Header.Set("Origin", "https://odysee.com")
		req.Header.Set("User-Agent", "CourseForge-Go/1")
		res, err := o.client.Do(req)
		if err != nil {
			return Target{}, ErrProvider
		}
		res.Body.Close()
		if res.StatusCode >= 300 && res.StatusCode <= 308 {
			next, e := res.Location()
			if e != nil {
				return Target{}, ErrProvider
			}
			target.URL = next.String()
			continue
		}
		if res.StatusCode >= 400 || !mediaType(res.Header.Get("Content-Type")) {
			return Target{}, ErrProvider
		}
		return target, nil
	}
	return Target{}, ErrProvider
}
