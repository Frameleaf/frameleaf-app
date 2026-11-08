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
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone/backend/iclouddrive/api"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

const testToken = "01234567890123456789012345678901"

func TestDependencyProvenance(t *testing.T) {
	version := capabilities["rcloneVersion"].(string)
	for file, expected := range map[string][]string{
		"go.mod":                    {"github.com/rclone/rclone " + version + "\n"},
		"licenses/rclone/NOTICE.md": {version, revision},
		"api.md":                    {version, revision},
	} {
		body, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for _, value := range expected {
			if !bytes.Contains(body, []byte(value)) {
				t.Errorf("%s does not match reported Rclone provenance: %s", file, value)
			}
		}
	}
	b := newBridge([]byte(testToken))
	w := httptest.NewRecorder()
	b.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/health", nil))
	var health struct {
		Commit string `json:"rcloneCommit"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &health); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || health.Commit != revision {
		t.Fatal("health response does not match reported Rclone provenance")
	}
}

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
	// A valid envelope and request must reach service-host validation before any outbound request.
	for _, host := range []string{"https://evil.test", "https://icloud.com.evil.test"} {
		e, err := restore(testSession(t))
		if err != nil {
			t.Fatal(err)
		}
		e.Upstream.AccountInfo.Webservices[api.WsPhotos].URL = host
		session, err := json.Marshal(e)
		if err != nil {
			t.Fatal(err)
		}
		calls := 0
		b.http = &http.Client{Transport: transportFunc(func(*http.Request) (*http.Response, error) {
			calls++
			return response(`{"records":[]}`), nil
		})}
		w := call(t, b, "/v1/inventory", request{Session: session, Kind: "albums", Library: &library{Area: "private", ZoneID: map[string]string{"zoneName": "PrimarySync"}}})
		if w.Code != 400 || calls != 0 {
			t.Fatalf("service host accepted: status=%d outbound=%d", w.Code, calls)
		}
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
func TestRestoreUsesAppleClientID(t *testing.T) {
	e := &envelope{Version: 1, AppleID: "test@example.com", Upstream: api.NewSession()}
	e.Upstream.ClientID = e.Upstream.FrameID // what bridges before #914 stored
	raw, _ := json.Marshal(e)
	restored, err := restore(raw)
	if err != nil || restored.Upstream.ClientID != appleClientID {
		t.Fatal("restored session must sign in with Apple's web client ID")
	}
}
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

func TestPCSHTTP423PreservesApprovalSession(t *testing.T) {
	for _, state := range []string{"awaiting-device-approval", "connected"} {
		t.Run(state, func(t *testing.T) {
			b := newBridge([]byte(testToken))
			calls := 0
			b.http = &http.Client{Transport: transportFunc(func(*http.Request) (*http.Response, error) {
				calls++
				r := response("SECRET provider response")
				r.StatusCode = 423
				r.Header.Add("Set-Cookie", "pending=rotated; Secure")
				return r, nil
			})}
			e, err := restore(testSession(t))
			if err != nil {
				t.Fatal(err)
			}
			e.State = state
			session, err := json.Marshal(e)
			if err != nil {
				t.Fatal(err)
			}
			w := call(t, b, "/v1/auth", request{Session: session, Action: "device-approval"})
			var result struct {
				State   string          `json:"state"`
				Session json.RawMessage `json:"session"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if w.Code != 200 || calls != 1 || result.State != "awaiting-device-approval" || strings.Contains(w.Body.String(), "SECRET") {
				t.Fatalf("approval lost: %d %s", w.Code, w.Body)
			}
			restored, err := restore(result.Session)
			if err != nil || restored.State != "awaiting-device-approval" || !bytes.Contains(result.Session, []byte("rotated")) {
				t.Fatal("pending session not retained")
			}
			w = call(t, b, "/v1/auth", request{Session: result.Session, Action: "device-approval"})
			if w.Code != 200 || calls != 2 {
				t.Fatal("subsequent approval action rejected")
			}
		})
	}
}

func inventoryPage(t *testing.T, b *bridge, q request) (records []json.RawMessage, next string, complete bool) {
	t.Helper()
	w := call(t, b, "/v1/inventory", q)
	if w.Code != 200 {
		t.Fatalf("inventory failed: %d %s", w.Code, w.Body)
	}
	var out struct {
		Records  []json.RawMessage `json:"records"`
		Next     string            `json:"nextCursor"`
		Complete bool              `json:"complete"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.Records, out.Next, out.Complete
}

func TestLibrariesWalkPrivateThenSharedDatabase(t *testing.T) {
	b := newBridge([]byte(testToken))
	var areas []string
	var bodies []map[string]any
	b.http = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		if !strings.HasSuffix(r.URL.Path, "/changes/database") {
			t.Fatalf("wrong endpoint: %s", r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		area := strings.Split(strings.TrimPrefix(r.URL.Path, "/database/1/com.apple.photos.cloud/production/"), "/")[0]
		areas = append(areas, area)
		switch len(areas) {
		case 1:
			return response(`{"zones":[{"zoneID":{"zoneName":"PrimarySync"}},{"zoneID":{"zoneName":"CMM-ignored"}}],"syncToken":"tok1","moreComing":true,"continuationMarker":"m1"}`), nil
		case 2:
			return response(`{"zones":[],"syncToken":"tok2","moreComing":false}`), nil
		default:
			return response(`{"zones":[{"zoneID":{"zoneName":"SharedSync-abc","ownerRecordName":"_owner"}}],"syncToken":"tok3"}`), nil
		}
	})}
	q := request{Session: testSession(t), Kind: "libraries"}
	records, next, complete := inventoryPage(t, b, q)
	if complete || next == "" || len(records) != 1 || !bytes.Contains(records[0], []byte(`"area":"private"`)) {
		t.Fatalf("first private page wrong: complete=%v records=%d", complete, len(records))
	}
	q.Cursor = next
	records, next, complete = inventoryPage(t, b, q)
	if complete || next == "" || len(records) != 0 {
		t.Fatal("private continuation must stay in the private phase until the database is drained")
	}
	if bodies[1]["syncToken"] != "tok1" || bodies[1]["continuationMarker"] != "m1" {
		t.Fatalf("continuation not forwarded: %v", bodies[1])
	}
	q.Cursor = next
	records, next, complete = inventoryPage(t, b, q)
	if !complete || next != "" || len(records) != 1 || !bytes.Contains(records[0], []byte(`"area":"shared"`)) {
		t.Fatalf("shared phase wrong: complete=%v next=%q records=%d", complete, next, len(records))
	}
	if strings.Join(areas, ",") != "private,private,shared" {
		t.Fatalf("database order wrong: %v", areas)
	}
	if _, ok := bodies[2]["syncToken"]; ok {
		t.Fatal("private sync token leaked into the shared database query")
	}
}

func TestMembershipsPaginateByAssetRecords(t *testing.T) {
	b := newBridge([]byte(testToken))
	var ranks []float64
	b.http = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		query := body["query"].(map[string]any)
		if query["recordType"] != "CPLContainerRelationLiveByAssetDate" || body["resultsLimit"] != 4.0 {
			t.Fatalf("wrong membership query: %v", body)
		}
		var rank float64
		parent := false
		for _, raw := range query["filterBy"].([]any) {
			filter := raw.(map[string]any)
			value := filter["fieldValue"].(map[string]any)
			switch filter["fieldName"] {
			case "startRank":
				rank = value["value"].(float64)
			case "parentId":
				parent = value["value"] == "album-1"
			}
		}
		if !parent {
			t.Fatal("album filter missing")
		}
		ranks = append(ranks, rank)
		switch len(ranks) {
		case 1:
			// Two assets, one of them without a master record: still a full page of ranks.
			return response(`{"records":[{"recordName":"a1","recordType":"CPLAsset"},{"recordName":"m1","recordType":"CPLMaster"},{"recordName":"a2","recordType":"CPLAsset"}]}`), nil
		case 2:
			return response(`{"records":[{"recordName":"a3","recordType":"CPLAsset"},{"recordName":"m3","recordType":"CPLMaster"}]}`), nil
		default:
			return response(`{"records":[{"recordName":"stray","recordType":"CPLMaster"}]}`), nil
		}
	})}
	lib := &library{Area: "private", ZoneID: map[string]string{"zoneName": "PrimarySync"}}
	q := request{Session: testSession(t), Kind: "memberships", Library: lib, AlbumID: "album-1", Limit: 2}
	var complete bool
	for page := 0; page < 3; page++ {
		var next string
		_, next, complete = inventoryPage(t, b, q)
		if complete != (page == 2) {
			t.Fatalf("page %d completion wrong", page)
		}
		q.Cursor = next
	}
	if len(ranks) != 3 || ranks[0] != 0 || ranks[1] != 2 || ranks[2] != 3 {
		t.Fatalf("rank must advance by the asset records returned: %v", ranks)
	}
	if call(t, b, "/v1/inventory", request{Session: testSession(t), Kind: "memberships", Library: lib}).Code != 400 {
		t.Fatal("memberships without an album accepted")
	}
}

func TestCursorIsBoundToItsScope(t *testing.T) {
	b := newBridge([]byte(testToken))
	calls := 0
	b.http = &http.Client{Transport: transportFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return response(`{"records":[{"recordName":"a1","recordType":"CPLAsset"}]}`), nil
	})}
	private := &library{Area: "private", ZoneID: map[string]string{"zoneName": "PrimarySync"}}
	shared := &library{Area: "shared", ZoneID: map[string]string{"zoneName": "SharedSync-1"}}
	_, next, _ := inventoryPage(t, b, request{Session: testSession(t), Kind: "assets", Library: private, Limit: 10})
	for _, q := range []request{
		{Session: testSession(t), Kind: "assets", Library: shared, Limit: 10, Cursor: next},
		{Session: testSession(t), Kind: "assets", Library: private, Limit: 20, Cursor: next},
		{Session: testSession(t), Kind: "memberships", Library: private, AlbumID: "x", Limit: 10, Cursor: next},
		{Session: testSession(t), Kind: "assets", Library: private, Limit: 10, Cursor: "not base64 json"},
	} {
		if w := call(t, b, "/v1/inventory", q); w.Code != 400 {
			t.Fatalf("cursor accepted outside its scope: %d %s", w.Code, w.Body)
		}
	}
	if calls != 1 {
		t.Fatal("a rejected cursor must not reach Apple")
	}
	if _, _, complete := inventoryPage(t, b, request{Session: testSession(t), Kind: "assets", Library: private, Limit: 10, Cursor: next}); complete {
		t.Fatal("a cursor in its own scope must continue")
	}
}

func TestAuthLimiterIsPerAccountWithGlobalCeiling(t *testing.T) {
	b := newBridge([]byte(testToken))
	now := time.Unix(1_700_000_000, 0)
	b.now = func() time.Time { return now }
	alice, bob := accountKey("Alice@Example.com "), accountKey("bob@example.com")
	if alice != accountKey("alice@example.com") {
		t.Fatal("account key must not depend on case or whitespace")
	}
	for i := 0; i < authAccountLimit; i++ {
		if !b.allowAuth(alice, true) {
			t.Fatalf("login %d refused early", i)
		}
	}
	if b.allowAuth(alice, true) {
		t.Fatal("account limit not enforced")
	}
	if !b.allowAuth(alice, false) || !b.allowAuth(bob, true) {
		t.Fatal("one account's logins must not throttle its validation or another account")
	}
	now = now.Add(authWindow + time.Second)
	if !b.allowAuth(alice, true) {
		t.Fatal("window did not slide")
	}
	if len(b.attempts) != 1 {
		t.Fatalf("stale accounts must be forgotten: %d", len(b.attempts))
	}
	for len(b.global) < authGlobalLimit {
		if !b.allowAuth(accountKey(strconv.Itoa(len(b.global))+"@example.com"), false) {
			t.Fatal("global ceiling reached early")
		}
	}
	if b.allowAuth(bob, false) || b.allowAuth(bob, true) {
		t.Fatal("global ceiling not enforced")
	}
	// Over HTTP: a throttled account's login is refused before any Apple traffic, with the stable code.
	b = newBridge([]byte(testToken))
	for i := 0; i < authAccountLimit; i++ {
		b.allowAuth(accountKey("carol@example.com"), true)
	}
	w := call(t, b, "/v1/auth", request{Action: "login", AppleID: "Carol@example.com", Password: "secret"})
	if w.Code != 429 || !strings.Contains(w.Body.String(), `"code":"rate_limited"`) {
		t.Fatalf("throttled login not refused: %d %s", w.Code, w.Body)
	}
	if call(t, b, "/v1/auth", request{Action: "validate", Session: testSession(t), Code: "123456"}).Code != 400 {
		t.Fatal("malformed validate accepted")
	}
}

func TestConnectedStateMachine(t *testing.T) {
	b := newBridge([]byte(testToken))
	fresh := func(status string, pcs bool) *envelope {
		e, err := restore(testSession(t))
		if err != nil {
			t.Fatal(err)
		}
		ws := e.Upstream.AccountInfo.Webservices[api.WsPhotos]
		ws.Status = status
		ws.PcsRequired = pcs
		return e
	}
	if err := b.connectedState(context.Background(), fresh("inactive", false)); err == nil {
		t.Fatal("inactive photos service accepted")
	}
	e := fresh("active", false)
	if err := b.connectedState(context.Background(), e); err != nil || e.State != "connected" {
		t.Fatal("active service without PCS requirement must connect")
	}
	e = fresh("active", true)
	if err := b.connectedState(context.Background(), e); err != nil || e.State != "awaiting-device-approval" {
		t.Fatal("PCS required without PCS cookies must await approval")
	}
	past, future := time.Now().Add(-time.Hour), time.Now().Add(time.Hour)
	e.Upstream.Cookies = []*http.Cookie{{Name: "X-APPLE-WEBAUTH-PCS-Photos", Value: "p", Expires: past}, {Name: "X-APPLE-WEBAUTH-PCS-Sharing", Value: "s"}}
	if hasPCS(e.Upstream) {
		t.Fatal("expired PCS cookie counted")
	}
	e.Upstream.Cookies[0].Expires = future
	if err := b.connectedState(context.Background(), e); err != nil || e.State != "connected" {
		t.Fatal("live PCS cookies must connect")
	}
	// A 2FA session that lost its state cannot take a code, and a code is six digits.
	e.State = "connected"
	raw, _ := json.Marshal(e)
	if call(t, b, "/v1/auth", request{Action: "two-factor", Session: raw, Code: "123456"}).Code != 400 {
		t.Fatal("two-factor accepted outside awaiting-2fa")
	}
	e.State = "awaiting-2fa"
	raw, _ = json.Marshal(e)
	for _, code := range []string{"12345", "12345a", ""} {
		if call(t, b, "/v1/auth", request{Action: "two-factor", Session: raw, Code: code}).Code != 400 {
			t.Fatalf("code %q accepted", code)
		}
	}
	if call(t, b, "/v1/auth", request{Action: "device-approval", Session: raw}).Code != 400 {
		t.Fatal("device approval accepted while awaiting 2FA")
	}
}

func TestMergeCookiesDropsExpiredAndRestorePrunes(t *testing.T) {
	s := api.NewSession()
	past, future := time.Now().Add(-time.Hour), time.Now().Add(time.Hour)
	s.Cookies = []*http.Cookie{{Name: "keep", Value: "1"}, {Name: "rotate", Value: "old"}, {Name: "gone", Value: "x"}, {Name: "dead", Value: "y"}}
	mergeCookies(s, []*http.Cookie{{Name: "rotate", Value: "new", Expires: future}, {Name: "gone", Value: "still-set", Expires: past}, {Name: "dead", Value: "", MaxAge: -1}})
	names := map[string]string{}
	for _, c := range s.Cookies {
		names[c.Name] = c.Value
	}
	if len(names) != 2 || names["keep"] != "1" || names["rotate"] != "new" {
		t.Fatalf("expired or deleted cookies kept: %v", names)
	}
	e, err := restore(testSession(t))
	if err != nil {
		t.Fatal(err)
	}
	e.Upstream.Cookies = []*http.Cookie{{Name: "live", Value: "1", Expires: future}, {Name: "stale", Value: "1", Expires: past}}
	raw, _ := json.Marshal(e)
	if e, err = restore(raw); err != nil || len(e.Upstream.Cookies) != 1 || e.Upstream.Cookies[0].Name != "live" {
		t.Fatal("restore must drop date-expired cookies")
	}
}

type failingBody struct {
	io.Reader
	after int
	read  int
}

func (f *failingBody) Read(p []byte) (int, error) {
	if f.read >= f.after {
		return 0, io.ErrUnexpectedEOF
	}
	if len(p) > f.after-f.read {
		p = p[:f.after-f.read]
	}
	n, err := f.Reader.Read(p)
	f.read += n
	return n, err
}
func (*failingBody) Close() error { return nil }

func downloadTransport(t *testing.T, content string, serve func(call int, r *http.Request) *http.Response) *http.Client {
	t.Helper()
	fetches := 0
	return &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, "/records/lookup") {
			fetches = 0
			return response(`{"records":[{"recordName":"master-1","fields":{"resOriginalRes":{"value":{"downloadURL":"https://asset.icloud-content.com/fresh","size":` + strconv.Itoa(len(content)) + `,"fileChecksum":"abc"}}}}]}`), nil
		}
		if r.Header.Get("Cookie") != "" {
			t.Fatal("session cookies forwarded to a signed URL")
		}
		fetches++
		return serve(fetches, r), nil
	})}
}

func downloadRequest(t *testing.T, rangeHeader string) *http.Request {
	t.Helper()
	q := request{Session: testSession(t), Library: &library{Area: "private", ZoneID: map[string]string{"zoneName": "PrimarySync"}}, RecordID: "master-1", ResourceKey: "resOriginalRes"}
	raw, _ := json.Marshal(q)
	req := httptest.NewRequest(http.MethodPost, "/v1/download", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+testToken)
	if rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}
	return req
}

func rangedResponse(content string, r *http.Request) *http.Response {
	start, end, _, err := parseRange(r.Header.Get("Range"), int64(len(content)))
	if err != nil {
		panic(err)
	}
	resp := response(content[start : end+1])
	if r.Header.Get("Range") != "" {
		resp.StatusCode = http.StatusPartialContent
		resp.Header.Set("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+strconv.FormatInt(end, 10)+"/"+strconv.Itoa(len(content)))
	}
	return resp
}

func TestDownloadHonoursClientRange(t *testing.T) {
	const content = "0123456789"
	b := newBridge([]byte(testToken))
	var upstreamRanges []string
	b.http = downloadTransport(t, content, func(_ int, r *http.Request) *http.Response {
		upstreamRanges = append(upstreamRanges, r.Header.Get("Range"))
		return rangedResponse(content, r)
	})
	w := httptest.NewRecorder()
	b.ServeHTTP(w, downloadRequest(t, "bytes=4-"))
	if w.Code != 206 || w.Body.String() != "456789" || w.Header().Get("Content-Range") != "bytes 4-9/10" || w.Header().Get("Content-Length") != "6" || w.Header().Get("X-ICloud-Resource-Size") != "10" || w.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatalf("open range wrong: %d %q %v", w.Code, w.Body, w.Header())
	}
	w = httptest.NewRecorder()
	b.ServeHTTP(w, downloadRequest(t, "bytes=2-3"))
	if w.Code != 206 || w.Body.String() != "23" || w.Header().Get("Content-Range") != "bytes 2-3/10" {
		t.Fatalf("closed range wrong: %d %q", w.Code, w.Body)
	}
	if strings.Join(upstreamRanges, ",") != "bytes=4-9,bytes=2-3" {
		t.Fatalf("ranges not forwarded to Apple: %v", upstreamRanges)
	}
	for header, status := range map[string]int{"bytes=10-": 416, "bytes=0-1,4-5": 400, "bytes=-5": 400, "bytes=5-2": 400, "items=1-2": 400} {
		w = httptest.NewRecorder()
		b.ServeHTTP(w, downloadRequest(t, header))
		if w.Code != status {
			t.Fatalf("%s: expected %d, got %d %s", header, status, w.Code, w.Body)
		}
	}
	// A server that ignores the Range header is read from the start and skipped to the offset.
	b.http = downloadTransport(t, content, func(_ int, r *http.Request) *http.Response { return response(content) })
	w = httptest.NewRecorder()
	b.ServeHTTP(w, downloadRequest(t, "bytes=7-"))
	if w.Code != 206 || w.Body.String() != "789" {
		t.Fatalf("fallback skip wrong: %d %q", w.Code, w.Body)
	}
}

func TestDownloadResumesAfterUpstreamBreak(t *testing.T) {
	const content = "abcdefghij"
	b := newBridge([]byte(testToken))
	var upstreamRanges []string
	b.http = downloadTransport(t, content, func(call int, r *http.Request) *http.Response {
		upstreamRanges = append(upstreamRanges, r.Header.Get("Range"))
		if call == 1 {
			resp := response(content)
			resp.Body = &failingBody{Reader: strings.NewReader(content), after: 4}
			return resp
		}
		return rangedResponse(content, r)
	})
	w := httptest.NewRecorder()
	b.ServeHTTP(w, downloadRequest(t, ""))
	if w.Code != 200 || w.Body.String() != content || w.Header().Get("Content-Length") != "10" {
		t.Fatalf("resumed download wrong: %d %q", w.Code, w.Body)
	}
	if strings.Join(upstreamRanges, ",") != ",bytes=4-9" {
		t.Fatalf("resume must continue from the first byte not yet delivered: %v", upstreamRanges)
	}
}

func abortsHandler(t *testing.T, b *bridge, req *http.Request) (w *httptest.ResponseRecorder) {
	t.Helper()
	w = httptest.NewRecorder()
	defer func() {
		if recovered := recover(); recovered != http.ErrAbortHandler {
			t.Fatalf("expected the stream to be aborted, got %v", recovered)
		}
	}()
	b.ServeHTTP(w, req)
	t.Fatal("truncated stream completed")
	return w
}

func TestDownloadTruncatedUpstreamAbortsTheStream(t *testing.T) {
	const content = "abcdef"
	b := newBridge([]byte(testToken))
	opens := 0
	b.http = downloadTransport(t, content, func(_ int, r *http.Request) *http.Response {
		opens++
		resp := response(content)
		resp.ContentLength = -1
		resp.Body = &failingBody{Reader: strings.NewReader(content), after: 3}
		return resp
	})
	w := abortsHandler(t, b, downloadRequest(t, ""))
	if w.Body.String() != "abc" || opens != 1+downloadReopenLimit {
		t.Fatalf("partial bytes %q after %d opens", w.Body, opens)
	}
	// A length that disagrees with the record is refused before any byte is written.
	b.http = downloadTransport(t, content, func(_ int, r *http.Request) *http.Response {
		resp := response("abc")
		return resp
	})
	w = httptest.NewRecorder()
	b.ServeHTTP(w, downloadRequest(t, ""))
	if w.Code != 502 {
		t.Fatalf("mismatched length accepted: %d", w.Code)
	}
}

func TestDownloadFailedReopenAbortsWithoutNilBody(t *testing.T) {
	const content = "abcdef"
	b := newBridge([]byte(testToken))
	opens := 0
	b.http = downloadTransport(t, content, func(call int, r *http.Request) *http.Response {
		opens++
		if call > 1 {
			// The resume is refused: openResource answers an error and no body.
			resp := response("")
			resp.StatusCode = http.StatusServiceUnavailable
			return resp
		}
		resp := response(content)
		resp.Body = &failingBody{Reader: strings.NewReader(content), after: 3}
		return resp
	})
	// abortsHandler fails on any panic other than http.ErrAbortHandler, including the nil-pointer
	// dereference a deferred Close on a nil body would raise.
	w := abortsHandler(t, b, downloadRequest(t, ""))
	if w.Body.String() != "abc" || opens != 2 {
		t.Fatalf("partial bytes %q after %d opens", w.Body, opens)
	}
}

func TestDownloadSkipToOffsetResetsIdleTimer(t *testing.T) {
	const content = "0123456789"
	previous := downloadIdleTimeout
	downloadIdleTimeout = 100 * time.Millisecond
	defer func() { downloadIdleTimeout = previous }()
	b := newBridge([]byte(testToken))
	// Apple ignores the Range header and the whole body trickles in slower than one idle timeout.
	b.http = downloadTransport(t, content, func(_ int, r *http.Request) *http.Response {
		resp := response(content)
		resp.Body = &tricklingBody{ctx: r.Context(), data: content, delay: 25 * time.Millisecond}
		return resp
	})
	w := httptest.NewRecorder()
	b.ServeHTTP(w, downloadRequest(t, "bytes=8-"))
	if w.Code != 206 || w.Body.String() != "89" {
		t.Fatalf("skip to the resume offset was cut short by the idle timer: %d %q", w.Code, w.Body)
	}
}

// tricklingBody yields one byte per delay and, like a real connection, fails once the request
// context is cancelled.
type tricklingBody struct {
	ctx   context.Context
	data  string
	delay time.Duration
}

func (b *tricklingBody) Read(p []byte) (int, error) {
	if len(b.data) == 0 {
		return 0, io.EOF
	}
	select {
	case <-b.ctx.Done():
		return 0, b.ctx.Err()
	case <-time.After(b.delay):
	}
	p[0] = b.data[0]
	b.data = b.data[1:]
	return 1, nil
}
func (*tricklingBody) Close() error { return nil }

func TestDownloadAbandonsAStalledTransfer(t *testing.T) {
	const content = "abcdef"
	previous := downloadIdleTimeout
	downloadIdleTimeout = 50 * time.Millisecond
	defer func() { downloadIdleTimeout = previous }()
	b := newBridge([]byte(testToken))
	b.http = downloadTransport(t, content, func(_ int, r *http.Request) *http.Response {
		resp := response(content)
		resp.Body = stalledBody{ctx: r.Context()}
		return resp
	})
	started := time.Now()
	abortsHandler(t, b, downloadRequest(t, ""))
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("stalled transfer held the handler for %s", elapsed)
	}
}

type stalledBody struct{ ctx context.Context }

func (s stalledBody) Read([]byte) (int, error) {
	<-s.ctx.Done()
	return 0, s.ctx.Err()
}
func (stalledBody) Close() error { return nil }
