package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"github.com/rclone/rclone/backend/iclouddrive/api"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

const testToken = "01234567890123456789012345678901"

func testSession(t *testing.T) json.RawMessage {
	t.Helper()
	e := &envelope{Version: 1, State: "connected", AppleID: "test@example.com", Upstream: api.NewSession()}
	if err := json.Unmarshal([]byte(`{"webservices":{"ckdatabasews":{"url":"https://p01-ckdatabasews.icloud.com","status":"active"}}}`), &e.Upstream.AccountInfo); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
func call(t *testing.T, b *bridge, path string, q any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(q)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+testToken)
	w := httptest.NewRecorder()
	b.ServeHTTP(w, req)
	return w
}
func response(body string) *http.Response {
	return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), ContentLength: int64(len(body))}
}
func TestProtocolAndRawPagination(t *testing.T) {
	b := newBridge([]byte(testToken))
	page := 0
	b.http = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		if r.Method != "POST" || !strings.HasSuffix(r.URL.Path, "/records/query") {
			t.Fatalf("wrong endpoint: %s", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if _, ok := body["desiredKeys"]; ok {
			t.Fatal("raw fields must not be projected")
		}
		page++
		switch page {
		case 1:
			return response(`{"records":[{"recordName":"master-1","recordType":"CPLMaster","recordChangeTag":"rev1","fields":{"resOriginalRes":{"value":{"size":3,"fileChecksum":"abc","downloadURL":"https://asset.icloud-content.com/old"}}}},{"recordName":"unrelated","recordType":"CPLMaster"}]}`), nil
		case 2:
			return response(`{"records":[{"recordName":"asset-1","recordType":"CPLAsset","recordChangeTag":"rev2","fields":{"masterRef":{"value":{"recordName":"master-1"}},"unknownFutureField":{"value":"kept"}}}]}`), nil
		default:
			return response(`{"records":[]}`), nil
		}
	})}
	q := request{Session: testSession(t), Kind: "assets", Library: &library{Area: "private", ZoneID: map[string]string{"zoneName": "PrimarySync"}}, Limit: 1}
	for i := 0; i < 3; i++ {
		w := call(t, b, "/v1/inventory", q)
		if w.Code != 200 {
			t.Fatalf("page %d: %d %s", i, w.Code, w.Body)
		}
		var out struct {
			Records  []json.RawMessage `json:"records"`
			Next     string            `json:"nextCursor"`
			Complete bool              `json:"complete"`
		}
		if json.Unmarshal(w.Body.Bytes(), &out) != nil {
			t.Fatal("invalid output")
		}
		if i == 0 && !bytes.Contains(out.Records[0], []byte("fileChecksum")) {
			t.Fatal("resource fields lost")
		}
		if i == 1 && !bytes.Contains(out.Records[0], []byte("unknownFutureField")) {
			t.Fatal("asset relationship lost across pages")
		}
		if out.Complete != (i == 2) {
			t.Fatal("wrong completion")
		}
		q.Cursor = out.Next
	}
	// A cursor from assets cannot be reused for another library/kind.
	q.Kind = "albums"
	q.Cursor = encodeCursor(cursor{Scope: "wrong"})
	if call(t, b, "/v1/inventory", q).Code != 400 {
		t.Fatal("unbound cursor accepted")
	}
}
func TestAlbumsPreserveParentsAndDuplicateNames(t *testing.T) {
	b := newBridge([]byte(testToken))
	calls := 0
	b.http = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if calls == 1 {
			return response(`{"records":[{"recordName":"a1","fields":{"albumNameEnc":{"value":"VHJpcA=="},"parentId":{"value":"parent1"}}}],"continuationMarker":"page2"}`), nil
		}
		if body["continuationMarker"] != "page2" {
			t.Fatal("missing continuation")
		}
		return response(`{"records":[{"recordName":"a2","fields":{"albumNameEnc":{"value":"VHJpcA=="},"parentId":{"value":"parent2"}}}]}`), nil
	})}
	q := request{Session: testSession(t), Kind: "albums", Library: &library{Area: "private", ZoneID: map[string]string{"zoneName": "PrimarySync"}}}
	w := call(t, b, "/v1/inventory", q)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	q.Cursor = out["nextCursor"].(string)
	w = call(t, b, "/v1/inventory", q)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "parent2") || !strings.Contains(w.Body.String(), "a2") {
		t.Fatal("album identity lost")
	}
}
func TestDownloadFreshResourceAndSession(t *testing.T) {
	b := newBridge([]byte(testToken))
	calls := 0
	b.http = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			if !strings.HasSuffix(r.URL.Path, "/records/lookup") {
				t.Fatal("download did not refresh record")
			}
			resp := response(`{"records":[{"recordName":"master-1","fields":{"filenameEnc":{"value":"SU1HXzAwMDEuSEVJQw==","type":"ENCRYPTED_BYTES"},"itemType":{"value":"public.heic","type":"STRING"},"assetDate":{"value":1720000000000,"type":"TIMESTAMP"},"isHidden":{"value":false},"keywords":{"value":["family"]},"resOriginalRes":{"value":{"downloadURL":"https://asset.icloud-content.com/fresh","size":3,"fileChecksum":"abc"}}}}]}`)
			resp.Header.Add("Set-Cookie", "fresh=cookie; Secure")
			return resp, nil
		}
		if r.URL.Path != "/fresh" || r.Header.Get("Cookie") != "" {
			t.Fatal("signed URL or session isolation failed")
		}
		resp := response("abc")
		resp.Header.Set("Content-Type", "image/jpeg")
		return resp, nil
	})}
	q := request{Session: testSession(t), Library: &library{Area: "private", ZoneID: map[string]string{"zoneName": "PrimarySync"}}, RecordID: "master-1", ResourceKey: "resOriginalRes"}
	w := call(t, b, "/v1/download", q)
	if w.Code != 200 || w.Body.String() != "abc" || w.Header().Get("X-ICloud-Resource-Size") != "3" {
		t.Fatalf("bad download: %d %s", w.Code, w.Body)
	}
	raw, err := base64.RawURLEncoding.DecodeString(w.Header().Get("X-ICloud-Session"))
	if err != nil || !bytes.Contains(raw, []byte("fresh")) {
		t.Fatal("updated session missing")
	}
	if w.Header().Get("X-ICloud-Resource-Fingerprint") == "" {
		t.Fatal("fingerprint missing")
	}
	calls = 0
	q.ExpectedFingerprint = "stale"
	w = call(t, b, "/v1/download", q)
	if w.Code != 409 || calls != 1 {
		t.Fatal("stale version downloaded")
	}
}
func TestSafetyBoundaries(t *testing.T) {
	for _, raw := range []string{"http://apple.com/a", "https://icloud.com.evil.test/a", "https://evil.test/a", "https://user@apple.com/a", "https://apple.com:444/a", "https://127.0.0.1/a", "https://apple.com/a#fragment"} {
		if validateURL(raw) == nil {
			t.Fatalf("unsafe URL accepted %s", raw)
		}
	}
	for _, raw := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:192.168.1.1", "2001:db8::1"} {
		if publicIP(netip.MustParseAddr(raw)) {
			t.Fatalf("nonpublic address accepted %s", raw)
		}
	}
	if !publicIP(netip.MustParseAddr("1.1.1.1")) {
		t.Fatal("public address rejected")
	}
	b := newBridge([]byte(testToken))
	req := httptest.NewRequest(http.MethodGet, "/v1/capabilities", nil)
	w := httptest.NewRecorder()
	b.ServeHTTP(w, req)
	if w.Code != 401 {
		t.Fatal("missing token accepted")
	}
	q := map[string]any{"session": json.RawMessage(`null`), "kind": "assets", "endpoint": "https://evil.test"}
	if call(t, b, "/v1/inventory", q).Code != 400 {
		t.Fatal("arbitrary endpoint accepted")
	}
	if call(t, b, "/v1/auth", map[string]string{"action": "bogus"}).Code != 400 {
		t.Fatal("invalid action accepted")
	}
	q = map[string]any{"session": testSession(t), "kind": "assets", "library": map[string]any{"area": "private", "zoneID": map[string]string{"zoneName": "CMM-shared"}}}
	if call(t, b, "/v1/inventory", q).Code != 400 {
		t.Fatal("unsupported zone accepted")
	}
	// Never echo upstream body/error details.
	b.http = &http.Client{Transport: transportFunc(func(*http.Request) (*http.Response, error) { return nil, fmtSecretError{} })}
	q = map[string]any{"session": testSession(t), "kind": "albums", "library": map[string]any{"area": "private", "zoneID": map[string]string{"zoneName": "PrimarySync"}}}
	w = call(t, b, "/v1/inventory", q)
	if w.Code != 502 || strings.Contains(w.Body.String(), "SECRET") {
		t.Fatal("upstream error leaked")
	}
}

type fmtSecretError struct{}

func (fmtSecretError) Error() string { return "SECRET signed URL token" }
func TestPendingSessionRestorationAndPCS(t *testing.T) {
	raw := testSession(t)
	e, err := restore(raw)
	if err != nil {
		t.Fatal(err)
	}
	e.State = "awaiting-device-approval"
	raw, _ = json.Marshal(e)
	e, err = restore(raw)
	if err != nil || e.State != "awaiting-device-approval" {
		t.Fatal("pending session lost")
	}
	b := newBridge([]byte(testToken))
	calls := 0
	b.http = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		resp := response(`{"status":"pending"}`)
		return resp, nil
	})}
	if err = b.approval(context.Background(), e); err != nil || calls != 1 || e.State != "awaiting-device-approval" {
		t.Fatal("PCS must make one attempt")
	}
	b.http = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		resp := response(`{"status":"success"}`)
		resp.Header.Add("Set-Cookie", "X-APPLE-WEBAUTH-PCS-Photos=p; Secure")
		resp.Header.Add("Set-Cookie", "X-APPLE-WEBAUTH-PCS-Sharing=s; Secure")
		return resp, nil
	})}
	if err = b.approval(context.Background(), e); err != nil || calls != 2 || e.State != "connected" {
		t.Fatal("PCS approval did not connect")
	}
}
func TestFingerprintIgnoresURLRefresh(t *testing.T) {
	a := map[string]json.RawMessage{"size": json.RawMessage(`3`), "fileChecksum": json.RawMessage(`"a"`), "downloadURL": json.RawMessage(`"old"`)}
	first := resourceFingerprint(a)
	a["downloadURL"] = json.RawMessage(`"new"`)
	if first != resourceFingerprint(a) {
		t.Fatal("URL refresh changed identity")
	}
	a["fileChecksum"] = json.RawMessage(`"b"`)
	if first == resourceFingerprint(a) {
		t.Fatal("content version did not change")
	}
}

func TestFingerprintCanonicalCrossLanguageFixture(t *testing.T) {
	var descriptor map[string]json.RawMessage
	raw := `{"size":3,"nested":{"z":2,"a":"<&>\u2028","2":"two","10":"ten","downloadURL":"old","accessToken":"secret"},"fileChecksum":"abc","downloadURL":"old","expiresAt":100,"password":"private","cookies":"private","arbitrary":"https://signed-url.test/private"}`
	if err := json.Unmarshal([]byte(raw), &descriptor); err != nil {
		t.Fatal(err)
	}
	const expected = "8839c995f94ca1d27ae4346d4d5ceb1b4bb2e750637b61864ebc78632f5c7b11"
	if resourceFingerprint(descriptor) != expected {
		t.Fatal("Go and TypeScript canonical fingerprint mismatch")
	}
	raw = `{"fileChecksum":"abc","nested":{"10":"ten","2":"two","a":"<&>\u2028","z":2,"downloadURL":"new"},"size":3}`
	descriptor = nil
	if err := json.Unmarshal([]byte(raw), &descriptor); err != nil {
		t.Fatal(err)
	}
	if resourceFingerprint(descriptor) != expected {
		t.Fatal("JSONB key reordering changed the fingerprint")
	}
}

func TestSanitizedCloudKitFailures(t *testing.T) {
	for _, tc := range []struct {
		name       string
		status     int
		body       string
		wantStatus int
		code       string
	}{
		{"http throttle", 429, `SECRET upstream body`, 429, "rate_limited"},
		{"top throttle", 200, `{"serverErrorCode":"THROTTLED","reason":"SECRET"}`, 429, "rate_limited"},
		{"error code throttle", 503, `{"errorCode":"THROTTLED","reason":"SECRET"}`, 429, "rate_limited"},
		{"zone throttle", 200, `{"zones":[{"serverErrorCode":"THROTTLED","reason":"SECRET"}]}`, 429, "rate_limited"},
		{"top expired", 400, `{"serverErrorCode":"CHANGE_TOKEN_EXPIRED","reason":"SECRET"}`, 409, "invalid_change_token"},
		{"zone expired", 200, `{"zones":[{"serverErrorCode":"CHANGE_TOKEN_EXPIRED","reason":"SECRET"}]}`, 409, "invalid_change_token"},
		{"unknown zone", 200, `{"zones":[{"serverErrorCode":"ZONE_NOT_FOUND","reason":"SECRET"}]}`, 502, "upstream_error"},
		{"unknown top", 200, `{"serverErrorCode":"BAD_REQUEST","reason":"CHANGE_TOKEN_EXPIRED SECRET"}`, 502, "upstream_error"},
		{"record conflict", 409, `{"serverErrorCode":"CONFLICT","reason":"SECRET"}`, 502, "upstream_error"},
		{"unrecognized alias", 200, `{"serverErrorCode":"TOKEN_EXPIRED","reason":"SECRET"}`, 502, "upstream_error"},
		{"numeric error", 200, `{"serverErrorCode":21,"reason":"SECRET"}`, 502, "upstream_error"},
		{"auth precedence", 401, `{"serverErrorCode":"CHANGE_TOKEN_EXPIRED","reason":"SECRET"}`, 409, "reauthentication_required"},
		{"malformed", 503, `SECRET`, 502, "upstream_error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := newBridge([]byte(testToken))
			b.http = &http.Client{Transport: transportFunc(func(*http.Request) (*http.Response, error) {
				r := response(tc.body)
				r.StatusCode = tc.status
				return r, nil
			})}
			q := request{Session: testSession(t), Kind: "changes", Library: &library{Area: "private", ZoneID: map[string]string{"zoneName": "PrimarySync"}}}
			w := call(t, b, "/v1/inventory", q)
			var result struct {
				Version int `json:"version"`
				Error   struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if w.Code != tc.wantStatus || result.Version != 1 || result.Error.Code != tc.code || result.Error.Message == "" || strings.Contains(w.Body.String(), "SECRET") {
				t.Fatalf("unexpected sanitized failure: %d %s", w.Code, w.Body)
			}
		})
	}
}

func TestPCSRateLimitIsNotReauthentication(t *testing.T) {
	b := newBridge([]byte(testToken))
	b.http = &http.Client{Transport: transportFunc(func(*http.Request) (*http.Response, error) {
		r := response("SECRET")
		r.StatusCode = 429
		return r, nil
	})}
	w := call(t, b, "/v1/auth", request{Session: testSession(t), Action: "device-approval"})
	if w.Code != 429 || !strings.Contains(w.Body.String(), `"code":"rate_limited"`) || strings.Contains(w.Body.String(), "SECRET") {
		t.Fatalf("PCS throttle lost: %d %s", w.Code, w.Body)
	}
}
