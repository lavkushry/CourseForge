package media

import (
	"errors"
	"net/url"
	"strconv"
	"time"
)

// FromEnvironment is shared by embedded development delivery and the standalone
// gateway. Credentials remain inside the resolver and are never client metadata.
func FromEnvironment(cookieSecure bool, getenv func(string) string) (Resolver, Config, func(), error) {
	c := Config{MaxTransfers: 64, RevalidateEvery: 8 * time.Second}
	if raw := getenv("CF_MEDIA_TRANSFER_LIMIT"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 4096 {
			return nil, c, nil, errors.New("CF_MEDIA_TRANSFER_LIMIT must be between 1 and 4096")
		}
		c.MaxTransfers = n
	}
	if simulator := getenv("CF_MEDIA_SIMULATOR_URL"); simulator != "" {
		if getenv("CF_DEV_MODE") != "true" || cookieSecure {
			return nil, c, nil, errors.New("media simulator requires explicit development mode and insecure local cookies")
		}
		u, err := url.Parse(simulator)
		if err != nil || u.Scheme != "http" || u.Host == "" || u.User != nil || u.Fragment != "" {
			return nil, c, nil, errors.New("invalid media simulator URL")
		}
		c.SimulatorOrigin = u.Scheme + "://" + u.Host
		return FixedResolver{Target: Target{URL: simulator}}, c, func() {}, nil
	}
	accounts := []Account{}
	for _, suffix := range []string{"", "_2", "_3"} {
		token, channel := getenv("ODYSEE_AUTH_TOKEN"+suffix), getenv("ODYSEE_CHANNEL_ID"+suffix)
		if (token == "") != (channel == "") {
			return nil, c, nil, errors.New("each configured Odysee account needs both token and channel")
		}
		if token != "" {
			accounts = append(accounts, Account{Token: token, Channel: channel})
		}
	}
	o := NewOdysee(accounts)
	return o, c, o.Close, nil
}
