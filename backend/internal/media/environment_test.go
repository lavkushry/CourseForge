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
