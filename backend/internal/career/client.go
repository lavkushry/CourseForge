package career

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type HTTPWorkerClient struct {
	BaseURL    string
	HTTPClient *http.Client
}

func NewHTTPWorkerClient(baseURL string) *HTTPWorkerClient {
	if baseURL == "" {
		baseURL = "http://127.0.0.1:18095"
	}
	return &HTTPWorkerClient{
		BaseURL: baseURL,
		HTTPClient: &http.Client{
			Timeout: 120 * time.Second, // Playwright sessions can take up to 2 mins
		},
	}
}

func (c *HTTPWorkerClient) TriggerBump(ctx context.Context, req WorkerBumpRequest) (*WorkerBumpResponse, error) {
	var resp WorkerBumpResponse
	if err := c.post(ctx, "/execute/bump", req, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

func (c *HTTPWorkerClient) TriggerApply(ctx context.Context, req WorkerApplyRequest) (*WorkerApplyResponse, error) {
	var resp WorkerApplyResponse
	if err := c.post(ctx, "/execute/apply", req, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

func (c *HTTPWorkerClient) TriggerOutreach(ctx context.Context, req WorkerOutreachRequest) (*WorkerOutreachResponse, error) {
	var resp WorkerOutreachResponse
	if err := c.post(ctx, "/execute/outreach", req, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

func (c *HTTPWorkerClient) GetWorkerHealth(ctx context.Context) (*WorkerHealthResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/health", nil)
	if err != nil {
		return nil, err
	}
	res, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("worker health check returned HTTP %d", res.StatusCode)
	}
	var out WorkerHealthResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *HTTPWorkerClient) post(ctx context.Context, endpoint string, payload any, result any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+endpoint, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("worker request to %s failed with status %d", endpoint, res.StatusCode)
	}
	return json.NewDecoder(res.Body).Decode(result)
}
