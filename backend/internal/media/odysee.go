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
	Accounts     []Account
	byChannel    map[string]Account
	client       *http.Client
	cache        map[string]cached
	channelCache map[string]string
	mu           sync.Mutex
	flights      singleflight.Group
	slots        chan struct{}
	now          func() time.Time
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
}

var claimName = regexp.MustCompile(`^[A-Za-z0-9_-]{1,300}$`)
var claimID = regexp.MustCompile(`^[0-9a-fA-F]{40}$`)

func NewOdysee(accounts []Account) *Odysee {
	ctx, cancel := context.WithCancel(context.Background())
	byChannel := make(map[string]Account, len(accounts))
	for _, a := range accounts {
		if a.Channel != "" {
			byChannel[a.Channel] = a
		}
	}
	return &Odysee{
		Accounts:     accounts,
		byChannel:    byChannel,
		client: &http.Client{
			Timeout: 12 * time.Second,
			Transport: &http.Transport{
				Proxy:               nil,
				MaxIdleConns:        128,
				MaxIdleConnsPerHost: 64,
				MaxConnsPerHost:     64,
				IdleConnTimeout:     90 * time.Second,
			},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		cache:        make(map[string]cached),
		channelCache: make(map[string]string),
		slots:        make(chan struct{}, 64),
		now:          time.Now,
		ctx:          ctx,
		cancel:       cancel,
	}
}

func (o *Odysee) Close() { o.cancel(); o.client.CloseIdleConnections() }

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
		resolveCtx, stop := context.WithTimeout(o.ctx, 45*time.Second)
		defer stop()
		select {
		case o.slots <- struct{}{}:
			defer func() { <-o.slots }()
		case <-time.After(5 * time.Second):
			return Target{}, ErrProvider
		case <-resolveCtx.Done():
			return Target{}, ErrProvider
		}

		// Step 1: Check known channel from cache or claim_search
		var targetChannel string
		o.mu.Lock()
		targetChannel = o.channelCache[source.ClaimID]
		o.mu.Unlock()

		if targetChannel == "" {
			searchCtx, cancelSearch := context.WithTimeout(resolveCtx, 3*time.Second)
			targetChannel = o.discoverChannel(searchCtx, source.ClaimID)
			cancelSearch()
			if targetChannel != "" {
				o.mu.Lock()
				o.channelCache[source.ClaimID] = targetChannel
				o.mu.Unlock()
			}
		}

		// Step 2: If we have an exact matching account for the uploading channel, try it first
		if targetChannel != "" {
			o.mu.Lock()
			acc, found := o.byChannel[targetChannel]
			o.mu.Unlock()
			if found && acc.Token != "" {
				target, err := o.resolveAccount(resolveCtx, source, acc)
				if err == nil && target.URL != "" {
					o.saveCache(key, target)
					return target, nil
				}
			}
		}

		// Step 3: Fast concurrent fan-out across all configured accounts
		fanCtx, cancelFan := context.WithCancel(resolveCtx)
		defer cancelFan()

		type res struct {
			target  Target
			account Account
		}
		ch := make(chan res, len(o.Accounts))
		var wg sync.WaitGroup

		for _, acc := range o.Accounts {
			if acc.Token == "" || acc.Channel == "" || acc.Channel == targetChannel {
				continue
			}
			wg.Add(1)
			go func(a Account) {
				defer wg.Done()
				t, err := o.resolveAccount(fanCtx, source, a)
				if err == nil && t.URL != "" {
					select {
					case ch <- res{target: t, account: a}:
						cancelFan()
					default:
					}
				}
			}(acc)
		}

		go func() {
			wg.Wait()
			close(ch)
		}()

		for r := range ch {
			o.mu.Lock()
			o.channelCache[source.ClaimID] = r.account.Channel
			o.mu.Unlock()
			o.saveCache(key, r.target)
			return r.target, nil
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

func (o *Odysee) discoverChannel(ctx context.Context, id string) string {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "claim_search",
		"params": map[string]any{
			"claim_ids": []string{id},
		},
	})
	req, err := http.NewRequestWithContext(ctx, "POST", "https://api.na-backend.odysee.com/api/v1/proxy?m=claim_search", strings.NewReader(string(body)))
	if err != nil {
		return ""
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := o.client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	var searchResp struct {
		Result struct {
			Items []struct {
				SigningChannel struct {
					ClaimID string `json:"claim_id"`
				} `json:"signing_channel"`
			} `json:"items"`
		} `json:"result"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&searchResp); err != nil {
		return ""
	}
	if len(searchResp.Result.Items) > 0 {
		return searchResp.Result.Items[0].SigningChannel.ClaimID
	}
	return ""
}

func (o *Odysee) saveCache(key string, target Target) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.cache) >= 4096 {
		for k, c := range o.cache {
			if !o.now().Before(c.Expires) {
				delete(o.cache, k)
			}
		}
		if len(o.cache) >= 4096 {
			for k := range o.cache {
				delete(o.cache, k)
				break
			}
		}
	}
	o.cache[key] = cached{Target: target, Expires: o.now().Add(45 * time.Minute)}
}

func (o *Odysee) rpc(ctx context.Context, account Account, method string, params map[string]any) (map[string]any, error) {
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(150 * time.Millisecond):
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
			if attempt == 0 {
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
			if attempt == 0 {
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
	if raw == "" {
		return Target{}, ErrProvider
	}
	ref := "https://odysee.com/$/embed/" + url.PathEscape(source.ClaimName) + "/" + url.PathEscape(source.ClaimID) + "?" + url.Values{"signature": {sig}, "signature_ts": {ts}}.Encode()
	target := Target{URL: raw, Referer: ref}
	validator := &Gateway{}
	for hop := 0; hop < 4; hop++ {
		if !validator.valid(target.URL) {
			return Target{}, ErrProvider
		}
		req, err := http.NewRequestWithContext(ctx, "GET", target.URL, nil)
		if err != nil {
			return Target{}, ErrProvider
		}
		req.Header.Set("Range", "bytes=0-0")
		req.Header.Set("Referer", ref)
		req.Header.Set("Origin", "https://odysee.com")
		req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
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
			resolvedNext := req.URL.ResolveReference(next).String()
			if strings.HasSuffix(strings.Split(target.URL, "?")[0], ".mp4") && strings.HasSuffix(strings.Split(resolvedNext, "?")[0], ".m3u8") {
				return target, nil
			}
			target.URL = resolvedNext
			continue
		}
		if res.StatusCode != 200 && res.StatusCode != 206 {
			return Target{}, ErrProvider
		}
		if !mediaType(res.Header.Get("Content-Type")) {
			return Target{}, ErrProvider
		}
		return target, nil
	}
	return Target{}, ErrProvider
}
