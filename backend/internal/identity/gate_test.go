package identity

import (
	"net/http/httptest"
	"testing"
)

func TestPasswordAdmissionHasNoWaitingQueue(t *testing.T) {
	s := &Service{hashSlots: make(chan struct{}, 1)}
	first := httptest.NewRecorder()
	if !s.acquireHash(first) {
		t.Fatal("first hashing slot rejected")
	}
	second := httptest.NewRecorder()
	if s.acquireHash(second) {
		t.Fatal("unbounded password work admitted")
	}
	if second.Code != 503 || second.Header().Get("Retry-After") != "1" {
		t.Fatal("overload response lacks bounded retry")
	}
	<-s.hashSlots
	if !s.acquireHash(httptest.NewRecorder()) {
		t.Fatal("hashing admission did not recover")
	}
	<-s.hashSlots
}
