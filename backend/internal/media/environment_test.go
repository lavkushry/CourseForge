package media

import "testing"

func TestEnvironmentRejectsUnsafeSimulatorAndIncompleteAccounts(t *testing.T) {
	for _, values := range []map[string]string{
		{"CF_MEDIA_SIMULATOR_URL": "http://localhost/media"},
		{"CF_DEV_MODE": "true", "CF_MEDIA_SIMULATOR_URL": "http://user:secret@localhost/media"},
		{"CF_DEV_MODE": "true", "CF_MEDIA_SIMULATOR_URL": "https://localhost/media"},
		{"CF_MEDIA_TRANSFER_LIMIT": "10000"},
		{"ODYSEE_AUTH_TOKEN": "synthetic"},
		{"ODYSEE_CHANNEL_ID_2": "synthetic"},
	} {
		if _, _, close, err := FromEnvironment(false, func(key string) string { return values[key] }); err == nil {
			close()
			t.Fatal("unsafe or incomplete media configuration accepted")
		}
	}
	values := map[string]string{"CF_DEV_MODE": "true", "CF_MEDIA_SIMULATOR_URL": "http://127.0.0.1/media.mp4"}
	if _, _, close, err := FromEnvironment(true, func(key string) string { return values[key] }); err == nil {
		close()
		t.Fatal("secure-cookie deployment accepted test media")
	}
	resolver, config, close, err := FromEnvironment(false, func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	defer close()
	if _, ok := resolver.(FixedResolver); !ok || config.SimulatorOrigin != "http://127.0.0.1" {
		t.Fatal("explicit development simulator configuration not preserved")
	}
}

func TestFromEnvironmentTransferLimit(t *testing.T) {
	t.Parallel()
	values := map[string]string{
		"CF_DEV_MODE":             "true",
		"CF_MEDIA_SIMULATOR_URL":  "http://127.0.0.1:18092/fault/stall",
		"CF_MEDIA_TRANSFER_LIMIT": "1",
	}
	_, config, closeFn, err := FromEnvironment(false, func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	if config.MaxTransfers != 1 {
		t.Fatalf("MaxTransfers=%d want 1", config.MaxTransfers)
	}
	if config.SimulatorOrigin != "http://127.0.0.1:18092" {
		t.Fatalf("SimulatorOrigin=%q", config.SimulatorOrigin)
	}
}

func TestForceSimulatorOverridesOdyseeAccounts(t *testing.T) {
	t.Parallel()
	values := map[string]string{
		"CF_DEV_MODE":               "true",
		"CF_MEDIA_SIMULATOR_URL":    "http://127.0.0.1:18092/fault/stall",
		"CF_MEDIA_FORCE_SIMULATOR":  "true",
		"ODYSEE_AUTH_TOKEN":         "synthetic-token",
		"ODYSEE_CHANNEL_ID":         "synthetic-channel",
		"ODYSEE_AUTH_TOKEN_2":       "synthetic-token-2",
		"ODYSEE_CHANNEL_ID_2":       "synthetic-channel-2",
	}
	resolver, config, closeFn, err := FromEnvironment(false, func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	fixed, ok := resolver.(FixedResolver)
	if !ok {
		t.Fatalf("resolver type %T want FixedResolver when FORCE_SIMULATOR=true", resolver)
	}
	if fixed.Target.URL != "http://127.0.0.1:18092/fault/stall" {
		t.Fatalf("Target.URL=%q", fixed.Target.URL)
	}
	if config.SimulatorOrigin != "http://127.0.0.1:18092" {
		t.Fatalf("SimulatorOrigin=%q", config.SimulatorOrigin)
	}
}

func TestSimulatorWithoutForceKeepsHybridWhenOdyseeConfigured(t *testing.T) {
	t.Parallel()
	values := map[string]string{
		"CF_DEV_MODE":            "true",
		"CF_MEDIA_SIMULATOR_URL": "http://127.0.0.1:18092/media.mp4",
		"ODYSEE_AUTH_TOKEN":      "synthetic-token",
		"ODYSEE_CHANNEL_ID":      "synthetic-channel",
	}
	resolver, _, closeFn, err := FromEnvironment(false, func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	if _, ok := resolver.(*HybridResolver); !ok {
		t.Fatalf("resolver type %T want *HybridResolver when Odysee configured without FORCE", resolver)
	}
}

func TestForceSimulatorRequiresSimulatorURL(t *testing.T) {
	t.Parallel()
	values := map[string]string{
		"CF_DEV_MODE":              "true",
		"CF_MEDIA_FORCE_SIMULATOR": "true",
	}
	if _, _, closeFn, err := FromEnvironment(false, func(key string) string { return values[key] }); err == nil {
		closeFn()
		t.Fatal("FORCE_SIMULATOR without SIMULATOR_URL accepted")
	}
}
