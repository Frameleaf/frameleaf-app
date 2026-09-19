package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone/backend/iclouddrive/api"
	"github.com/rclone/rclone/fs"
)

const revision = "687d264b689b8c49a67e2e52a8a5e0caa01c04ce"
const maxBody = 2 << 20
const maxMetadata = 16 << 20

var capabilities = map[string]any{
	"protocolVersion": 1, "rcloneVersion": "v1.75.1", "rcloneCommit": revision,
	"rawRecords": true, "pagedInventory": true, "originals": true, "livePhotos": true, "rawAlternatives": true, "renderedEdits": true,
	"sharedLibraries": true, "sharedAlbums": false, "adjustmentRendering": false, "editedLivePhotoPairing": false, "smsTwoFactor": false, "cloudWrites": false,
	"fingerprintAlgorithm": "sha256-descriptor-v1",
}

type envelope struct {
	Version  int          `json:"version"`
	State    string       `json:"state"`
	AppleID  string       `json:"appleId"`
	Upstream *api.Session `json:"upstream"`
}
type library struct {
	Area   string            `json:"area"`
	ZoneID map[string]string `json:"zoneID"`
}
type request struct {
	Action              string          `json:"action,omitempty"`
	AppleID             string          `json:"appleId,omitempty"`
	Password            string          `json:"password,omitempty"`
	Code                string          `json:"code,omitempty"`
	Session             json.RawMessage `json:"session,omitempty"`
	Kind                string          `json:"kind,omitempty"`
	Library             *library        `json:"library,omitempty"`
	AlbumID             string          `json:"albumId,omitempty"`
	Cursor              string          `json:"cursor,omitempty"`
	Limit               int             `json:"limit,omitempty"`
	RecordID            string          `json:"recordId,omitempty"`
	ResourceKey         string          `json:"resourceKey,omitempty"`
	ExpectedFingerprint string          `json:"expectedFingerprint,omitempty"`
}
type cursor struct {
	Scope  string `json:"s"`
	Marker string `json:"m,omitempty"`
	Rank   int    `json:"r,omitempty"`
	Phase  int    `json:"p,omitempty"`
	Token  string `json:"t,omitempty"`
}
type fault struct {
	status int
	code   string
}

func (e fault) Error() string { return e.code }
func bad() error              { return fault{400, "invalid_request"} }
func upstream() error         { return fault{502, "upstream_error"} }

type bridge struct {
	token    [32]byte
	http     *http.Client
	mu       sync.Mutex
	attempts []time.Time
}

func newBridge(token []byte) *bridge { return &bridge{token: sha256.Sum256(token), http: safeClient()} }
func (b *bridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.URL.Path == "/health" && r.Method == http.MethodGet {
		writeJSON(w, map[string]any{"version": 1, "ready": true, "rcloneCommit": revision})
		return
	}
	presented := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	sum := sha256.Sum256([]byte(presented))
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || subtle.ConstantTimeCompare(sum[:], b.token[:]) != 1 {
		writeError(w, fault{401, "unauthorized"})
		return
	}
	if r.URL.RawQuery != "" {
		writeError(w, bad())
		return
	}
	if r.URL.Path == "/v1/capabilities" && r.Method == http.MethodGet {
		writeJSON(w, map[string]any{"version": 1, "capabilities": capabilities})
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, bad())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	r = r.WithContext(ctx)
	var q request
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&q); err != nil {
		writeError(w, bad())
		return
	}
	if dec.Decode(&struct{}{}) != io.EOF {
		writeError(w, bad())
		return
	}
	var err error
	switch r.URL.Path {
	case "/v1/auth":
		err = b.auth(w, r, &q)
	case "/v1/inventory":
		err = b.inventory(w, r, &q)
	case "/v1/download":
		err = b.download(w, r, &q)
	default:
		err = bad()
	}
	if err != nil {
		writeError(w, err)
	}
}
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
func writeError(w http.ResponseWriter, err error) {
	f := fault{502, "upstream_error"}
	var typed fault
	if errors.As(err, &typed) {
		f = typed
	}
	messages := map[string]string{"invalid_request": "Invalid bridge request.", "unauthorized": "Authentication required.", "reauthentication_required": "Apple authentication must be renewed.", "device_approval_required": "Approve access on a trusted Apple device.", "resource_changed": "The source resource changed; refresh inventory.", "rate_limited": "The request was throttled; retry later.", "invalid_change_token": "The change cursor expired; refresh inventory.", "upstream_error": "The Apple request could not be completed.", "unsupported": "This operation is unsupported."}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(f.status)
	_ = json.NewEncoder(w).Encode(map[string]any{"version": 1, "error": map[string]string{"code": f.code, "message": messages[f.code]}})
}
func restore(raw json.RawMessage) (*envelope, error) {
	e := &envelope{Upstream: api.NewSession()}
	if len(raw) == 0 || json.Unmarshal(raw, e) != nil || e.Version != 1 || e.Upstream == nil || len(e.AppleID) > 320 || e.AppleID == "" {
		return nil, bad()
	}
	return e, nil
}
func (b *bridge) allowAuth() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-time.Minute)
	keep := b.attempts[:0]
	for _, t := range b.attempts {
		if t.After(cutoff) {
			keep = append(keep, t)
		}
	}
	b.attempts = keep
	if len(b.attempts) >= 10 {
		return false
	}
	b.attempts = append(b.attempts, now)
	return true
}
func (b *bridge) auth(w http.ResponseWriter, r *http.Request, q *request) error {
	if !b.allowAuth() {
		return fault{429, "rate_limited"}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	var e *envelope
	var err error
	if q.Action == "login" {
		if q.AppleID == "" || len(q.AppleID) > 320 || q.Password == "" || len(q.Password) > 4096 || len(q.Session) > 0 || q.Code != "" {
			return bad()
		}
		e = &envelope{Version: 1, AppleID: strings.ToLower(strings.TrimSpace(q.AppleID)), Upstream: api.NewSession()}
		// Rclone expects a stable client identifier for the authentication flow.
		e.Upstream.ClientID = e.Upstream.FrameID
		err = e.Upstream.SignIn(ctx, e.AppleID, q.Password)
		q.Password = ""
		if err == nil && e.Upstream.Requires2FA() {
			e.State = "awaiting-2fa"
			if e.Upstream.RequestPushNotification(ctx) != nil {
				return upstream()
			}
		} else if err == nil {
			err = e.Upstream.AuthWithToken(ctx)
			if err == nil {
				err = b.connectedState(ctx, e)
			}
		}
	} else {
		if q.Password != "" || q.AppleID != "" {
			return bad()
		}
		e, err = restore(q.Session)
		if err != nil {
			return err
		}
		switch q.Action {
		case "two-factor":
			if e.State != "awaiting-2fa" || len(q.Code) != 6 || strings.Trim(q.Code, "0123456789") != "" {
				return bad()
			}
			err = e.Upstream.Validate2FACode(ctx, q.Code)
			q.Code = ""
			if err == nil {
				err = e.Upstream.ValidateSession(ctx)
			}
			if err == nil {
				err = b.connectedState(ctx, e)
			}
		case "validate":
			if q.Code != "" {
				return bad()
			}
			err = e.Upstream.ValidateSession(ctx)
			if err == nil {
				err = b.connectedState(ctx, e)
			}
		case "device-approval":
			if q.Code != "" || (e.State != "awaiting-device-approval" && e.State != "connected") {
				return bad()
			}
			err = b.approval(ctx, e)
		default:
			return bad()
		}
	}
	if err != nil {
		var f fault
		e.State = "reauthentication-required"
		if errors.As(err, &f) {
			switch f.code {
			case "rate_limited":
				return f
			case "device_approval_required":
				e.State = "awaiting-device-approval"
			}
		}
	}
	writeJSON(w, map[string]any{"version": 1, "state": e.State, "session": e, "capabilities": capabilities})
	return nil
}
func (b *bridge) connectedState(ctx context.Context, e *envelope) error {
	ws := e.Upstream.AccountInfo.Webservices[api.WsPhotos]
	if ws == nil || ws.Status != "active" {
		return upstream()
	}
	if ws.PcsRequired && !hasPCS(e.Upstream) {
		e.State = "awaiting-device-approval"
		return nil
	}
	e.State = "connected"
	return nil
}
func hasPCS(s *api.Session) bool {
	for _, name := range []string{"X-APPLE-WEBAUTH-PCS-Photos", "X-APPLE-WEBAUTH-PCS-Sharing"} {
		found := false
		for _, c := range s.Cookies {
			if c != nil && c.Name == name && c.Value != "" && c.MaxAge >= 0 && (c.Expires.IsZero() || c.Expires.After(time.Now())) {
				found = true
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func (b *bridge) approval(ctx context.Context, e *envelope) error {
	var response struct {
		Status string `json:"status"`
	}
	if err := b.post(ctx, e, "https://setup.icloud.com/setup/ws/1/requestPCS", map[string]any{"appName": "photos", "derivedFromUserAction": true}, &response); err != nil {
		return err
	}
	if response.Status == "success" && hasPCS(e.Upstream) {
		e.State = "connected"
	} else {
		e.State = "awaiting-device-approval"
	}
	return nil
}
func (b *bridge) post(ctx context.Context, e *envelope, target string, body, response any) error {
	if err := validateURL(target); err != nil {
		return bad()
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return bad()
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(raw))
	if err != nil {
		return bad()
	}
	for k, v := range e.Upstream.GetHeaders(map[string]string{"Content-Type": "text/plain"}) {
		req.Header.Set(k, v)
	}
	client := *b.http
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return upstream()
	}
	defer resp.Body.Close()
	mergeCookies(e.Upstream, resp.Cookies())
	for name, target := range map[string]*string{
		"X-Apple-ID-Account-Country": &e.Upstream.AccountCountry,
		"X-Apple-ID-Session-Id":      &e.Upstream.SessionID,
		"X-Apple-Session-Token":      &e.Upstream.SessionToken,
		"X-Apple-TwoSV-Trust-Token":  &e.Upstream.TrustToken,
		"scnt":                       &e.Upstream.Scnt,
		"X-Apple-Auth-Attributes":    &e.Upstream.AuthAttributes,
	} {
		if value := resp.Header.Get(name); value != "" {
			*target = value
		}
	}
	if resp.StatusCode == 401 || resp.StatusCode == 421 {
		return fault{409, "reauthentication_required"}
	}
	if resp.StatusCode == 423 {
		return fault{409, "device_approval_required"}
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return fault{429, "rate_limited"}
	}
	raw, err = io.ReadAll(io.LimitReader(resp.Body, maxMetadata+1))
	if err != nil || len(raw) > maxMetadata {
		return upstream()
	}
	var status struct {
		cloudFailure
		Zones []cloudFailure `json:"zones"`
	}
	if json.Unmarshal(raw, &status) != nil {
		return upstream()
	}
	for _, failure := range append([]cloudFailure{status.cloudFailure}, status.Zones...) {
		if err := failure.err(); err != nil {
			return err
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return upstream()
	}
	if json.Unmarshal(raw, response) != nil {
		return upstream()
	}
	return nil
}

// CloudKit codes are exact protocol fields; never classify upstream reason/message text.
type cloudFailure struct {
	ServerErrorCode string `json:"serverErrorCode"`
	ErrorCode       string `json:"errorCode"`
}

func (f cloudFailure) err() error {
	for _, code := range []string{f.ServerErrorCode, f.ErrorCode} {
		switch code {
		case "":
			continue
		case "THROTTLED":
			return fault{429, "rate_limited"}
		case "CHANGE_TOKEN_EXPIRED":
			return fault{409, "invalid_change_token"}
		default:
			return upstream()
		}
	}
	return nil
}

func mergeCookies(s *api.Session, in []*http.Cookie) {
	for _, c := range in {
		if c == nil {
			continue
		}
		out := s.Cookies[:0]
		for _, old := range s.Cookies {
			if old != nil && old.Name != c.Name {
				out = append(out, old)
			}
		}
		s.Cookies = out
		if c.Value != "" && c.MaxAge >= 0 {
			s.Cookies = append(s.Cookies, c)
		}
	}
}
func validLibrary(l *library) bool {
	if l == nil || (l.Area != "private" && l.Area != "shared") || len(l.ZoneID) > 3 {
		return false
	}
	for k, v := range l.ZoneID {
		if (k != "zoneName" && k != "ownerRecordName" && k != "zoneType") || len(v) > 512 {
			return false
		}
	}
	name := l.ZoneID["zoneName"]
	return name == "PrimarySync" || strings.HasPrefix(name, "SharedSync")
}
func endpoint(e *envelope, area, path string) (string, error) {
	ws := e.Upstream.AccountInfo.Webservices[api.WsPhotos]
	if ws == nil || ws.Status != "active" {
		return "", fault{409, "reauthentication_required"}
	}
	root, err := url.Parse(ws.URL)
	if err != nil || root.RawQuery != "" || root.Fragment != "" || (root.Path != "" && root.Path != "/") || validateURL(ws.URL) != nil {
		return "", bad()
	}
	return strings.TrimRight(ws.URL, "/") + "/database/1/com.apple.photos.cloud/production/" + area + "/" + path + "?remapEnums=true&getCurrentSyncToken=true", nil
}
func (b *bridge) cloud(ctx context.Context, e *envelope, area, path string, body, out any) error {
	target, err := endpoint(e, area, path)
	if err != nil {
		return err
	}
	return b.post(ctx, e, target, body, out)
}
func scope(q *request) string {
	raw, _ := json.Marshal([]any{q.Kind, q.Library, q.AlbumID, q.Limit})
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:])
}
func decodeCursor(q *request) (cursor, error) {
	c := cursor{Scope: scope(q)}
	if q.Cursor == "" {
		return c, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(q.Cursor)
	if err != nil || len(raw) > 16384 || json.Unmarshal(raw, &c) != nil || c.Scope != scope(q) || c.Rank < 0 || c.Rank > 1_000_000_000 || c.Phase < 0 || c.Phase > 2 {
		return c, bad()
	}
	return c, nil
}
func encodeCursor(c cursor) string {
	raw, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(raw)
}
func field(name, typ string, value any) map[string]any {
	return map[string]any{"fieldName": name, "comparator": "EQUALS", "fieldValue": map[string]any{"type": typ, "value": value}}
}
func (b *bridge) inventory(w http.ResponseWriter, r *http.Request, q *request) error {
	e, err := restore(q.Session)
	if err != nil {
		return err
	}
	if e.State != "connected" {
		return fault{409, "reauthentication_required"}
	}
	if q.Limit == 0 {
		q.Limit = 100
	}
	if q.Limit < 1 || q.Limit > 100 {
		return bad()
	}
	if q.Kind != "libraries" && !validLibrary(q.Library) {
		return bad()
	}
	if len(q.AlbumID) > 512 {
		return bad()
	}
	c, err := decodeCursor(q)
	if err != nil {
		return err
	}
	records := []json.RawMessage{}
	complete := false
	next := ""
	switch q.Kind {
	case "libraries":
		if q.Library != nil || q.AlbumID != "" || c.Phase > 1 {
			return bad()
		}
		area := []string{"private", "shared"}[c.Phase]
		var out struct {
			Zones              []json.RawMessage `json:"zones"`
			SyncToken          string            `json:"syncToken"`
			MoreComing         bool              `json:"moreComing"`
			ContinuationMarker string            `json:"continuationMarker"`
		}
		body := map[string]any{}
		if c.Token != "" {
			body["syncToken"] = c.Token
		}
		if c.Marker != "" {
			body["continuationMarker"] = c.Marker
		}
		if err = b.cloud(r.Context(), e, area, "changes/database", body, &out); err != nil {
			return err
		}
		for _, raw := range out.Zones {
			var zone map[string]json.RawMessage
			if json.Unmarshal(raw, &zone) != nil {
				return upstream()
			}
			var id map[string]string
			_ = json.Unmarshal(zone["zoneID"], &id)
			name := id["zoneName"]
			if name != "PrimarySync" && !strings.HasPrefix(name, "SharedSync") {
				continue
			}
			zone["area"], _ = json.Marshal(area)
			row, _ := json.Marshal(zone)
			records = append(records, row)
		}
		if out.MoreComing || out.ContinuationMarker != "" {
			if out.SyncToken == c.Token && out.ContinuationMarker == c.Marker {
				return upstream()
			}
			c.Token = out.SyncToken
			c.Marker = out.ContinuationMarker
		} else {
			c.Phase++
			c.Token = ""
			c.Marker = ""
		}
		complete = c.Phase == 2
		if !complete {
			next = encodeCursor(c)
		}
	case "albums", "assets", "memberships":
		body := map[string]any{"zoneID": q.Library.ZoneID, "resultsLimit": q.Limit}
		query := map[string]any{}
		if q.Kind == "albums" {
			query["recordType"] = "CPLAlbumByPositionLive"
			if c.Marker != "" {
				body["continuationMarker"] = c.Marker
			}
		} else {
			typ := "CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted"
			if c.Phase == 1 {
				typ = "CPLAssetAndMasterHiddenByAssetDate"
			}
			if c.Phase > 1 {
				return bad()
			}
			filters := []map[string]any{field("startRank", "INT64", c.Rank), field("direction", "STRING", "ASCENDING")}
			if q.Kind == "memberships" {
				if q.AlbumID == "" || c.Phase != 0 {
					return bad()
				}
				typ = "CPLContainerRelationLiveByAssetDate"
				filters = append(filters, field("parentId", "STRING", q.AlbumID))
			}
			query["recordType"] = typ
			query["filterBy"] = filters
			body["resultsLimit"] = 2 * q.Limit
		}
		body["query"] = query
		var out struct {
			Records            []json.RawMessage `json:"records"`
			ContinuationMarker string            `json:"continuationMarker"`
		}
		if err = b.cloud(r.Context(), e, q.Library.Area, "records/query", body, &out); err != nil {
			return err
		}
		records = out.Records
		if q.Kind == "albums" {
			complete = out.ContinuationMarker == ""
			if !complete && out.ContinuationMarker == c.Marker {
				return upstream()
			}
			c.Marker = out.ContinuationMarker
		} else {
			complete = len(records) < 2*q.Limit
			c.Rank += q.Limit
			if complete && q.Kind == "assets" && c.Phase == 0 {
				c.Phase = 1
				c.Rank = 0
				complete = false
			}
		}
		if !complete {
			next = encodeCursor(c)
		}
	case "changes":
		zone := map[string]any{"zoneID": q.Library.ZoneID}
		if c.Token != "" {
			zone["syncToken"] = c.Token
		}
		var out struct {
			Zones []struct {
				Records         []json.RawMessage `json:"records"`
				SyncToken       string            `json:"syncToken"`
				MoreComing      bool              `json:"moreComing"`
				ServerErrorCode string            `json:"serverErrorCode"`
			} `json:"zones"`
		}
		if err = b.cloud(r.Context(), e, q.Library.Area, "changes/zone", map[string]any{"zones": []any{zone}, "resultsLimit": 2 * q.Limit}, &out); err != nil {
			return err
		}
		if len(out.Zones) != 1 || out.Zones[0].ServerErrorCode != "" || out.Zones[0].SyncToken == "" {
			return upstream()
		}
		z := out.Zones[0]
		if z.MoreComing && z.SyncToken == c.Token {
			return upstream()
		}
		records = z.Records
		complete = !z.MoreComing
		c.Token = z.SyncToken
		next = encodeCursor(c)
	default:
		return bad()
	}
	if records == nil {
		records = []json.RawMessage{}
	}
	result := map[string]any{"version": 1, "session": e, "records": records, "complete": complete, "capabilities": capabilities}
	if next != "" {
		result["nextCursor"] = next
	}
	writeJSON(w, result)
	return nil
}

var sensitiveResourceKey = regexp.MustCompile(`(?i)url|token|expir|password|secret|credential|cookie|authorization|session|authattributes|scnt`)
var sensitiveResourceValue = regexp.MustCompile(`(?i)https?://|data:|bearer\s`)

func resourceValueAllowed(value any) bool {
	text, ok := value.(string)
	return !ok || !sensitiveResourceValue.MatchString(text)
}
func canonicalResource(value any) any {
	switch value := value.(type) {
	case map[string]any:
		stable := make(map[string]any, len(value))
		for key, item := range value {
			if sensitiveResourceKey.MatchString(key) || !resourceValueAllowed(item) {
				continue
			}
			stable[key] = canonicalResource(item)
		}
		return stable
	case []any:
		stable := make([]any, 0, len(value))
		for _, item := range value {
			if resourceValueAllowed(item) {
				stable = append(stable, canonicalResource(item))
			}
		}
		return stable
	default:
		return value
	}
}
func resourceFingerprint(value map[string]json.RawMessage) string {
	raw, _ := json.Marshal(value)
	var decoded any
	_ = json.Unmarshal(raw, &decoded)
	raw, _ = json.Marshal(canonicalResource(decoded))
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func (b *bridge) download(w http.ResponseWriter, r *http.Request, q *request) error {
	if !validLibrary(q.Library) || q.RecordID == "" || len(q.RecordID) > 512 {
		return bad()
	}
	switch q.ResourceKey {
	case "resOriginalRes", "resOriginalVidComplRes", "resOriginalAltRes", "resJPEGFullRes", "resVidFullRes":
	default:
		return bad()
	}
	e, err := restore(q.Session)
	if err != nil {
		return err
	}
	if e.State != "connected" {
		return fault{409, "reauthentication_required"}
	}
	var out struct {
		Records []struct {
			RecordName      string                     `json:"recordName"`
			Fields          map[string]json.RawMessage `json:"fields"`
			ServerErrorCode string                     `json:"serverErrorCode"`
		} `json:"records"`
	}
	body := map[string]any{"zoneID": q.Library.ZoneID, "records": []any{map[string]string{"recordName": q.RecordID}}}
	if err = b.cloud(r.Context(), e, q.Library.Area, "records/lookup", body, &out); err != nil {
		return err
	}
	if len(out.Records) != 1 || out.Records[0].ServerErrorCode != "" || out.Records[0].RecordName != q.RecordID {
		return upstream()
	}
	var field struct {
		Value map[string]json.RawMessage `json:"value"`
	}
	if json.Unmarshal(out.Records[0].Fields[q.ResourceKey], &field) != nil || len(field.Value) == 0 {
		return upstream()
	}
	value := field.Value
	var target string
	if json.Unmarshal(value["downloadURL"], &target) != nil || validateURL(target) != nil {
		return upstream()
	}
	fp := resourceFingerprint(value)
	if q.ExpectedFingerprint != "" && q.ExpectedFingerprint != fp {
		return fault{409, "resource_changed"}
	}
	var size int64
	if json.Unmarshal(value["size"], &size) != nil || size < 0 {
		return upstream()
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
	if err != nil {
		return upstream()
	}
	// Signed resource URLs are self-authorizing. Never forward Apple session cookies.
	resp, err := b.http.Do(req)
	if err != nil {
		return upstream()
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || (resp.ContentLength >= 0 && resp.ContentLength != size) {
		return upstream()
	}
	session, _ := json.Marshal(e)
	w.Header().Set("X-ICloud-Session", base64.RawURLEncoding.EncodeToString(session))
	w.Header().Set("X-ICloud-Resource-Fingerprint", fp)
	w.Header().Set("X-ICloud-Resource-Size", strconv.FormatInt(size, 10))
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	typ := resp.Header.Get("Content-Type")
	if typ == "" {
		typ = "application/octet-stream"
	}
	w.Header().Set("Content-Type", typ)
	w.WriteHeader(http.StatusOK)
	if _, err = io.CopyN(w, resp.Body, size); err != nil {
		panic(http.ErrAbortHandler)
	}
	return nil
}
func allowedHost(host string) bool {
	host = strings.ToLower(host)
	for _, suffix := range []string{"icloud.com", "icloud-content.com", "apple.com"} {
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			return true
		}
	}
	return false
}
func validateURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || !allowedHost(u.Hostname()) || (u.Port() != "" && u.Port() != "443") {
		return bad()
	}
	return nil
}
func publicIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
		return false
	}
	// Include nonpublic special-purpose ranges not covered by netip.IsPrivate.
	for _, cidr := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32", "2001::/23", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2002::/16", "fec0::/10", "::/96"} {
		if netip.MustParsePrefix(cidr).Contains(ip) {
			return false
		}
	}
	return true
}
func safeClient() *http.Client {
	transport := &http.Transport{Proxy: nil, ForceAttemptHTTP2: true, TLSHandshakeTimeout: 15 * time.Second, ResponseHeaderTimeout: 60 * time.Second, IdleConnTimeout: 60 * time.Second, MaxIdleConns: 20}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil || port != "443" || !allowedHost(host) {
			return nil, bad()
		}
		ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil || len(ips) == 0 {
			return nil, upstream()
		}
		for _, ip := range ips {
			if !publicIP(ip) {
				return nil, bad()
			}
		}
		dialer := net.Dialer{Timeout: 20 * time.Second, KeepAlive: 30 * time.Second}
		for _, ip := range ips {
			conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if dialErr == nil {
				return conn, nil
			}
		}
		return nil, upstream()
	}
	return &http.Client{Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return bad()
		}
		return validateURL(req.URL.String())
	}}
}
func envDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func main() {
	// Suppress upstream auth debug/error text: it is not safe application telemetry.
	fs.GetConfig(context.Background()).LogLevel = fs.LogLevelEmergency
	fs.GetConfig(context.Background()).Dump = 0
	log.SetOutput(io.Discard)
	token, err := os.ReadFile(envDefault("ICLOUD_BRIDGE_TOKEN_FILE", "/run/secrets/icloud_bridge_token"))
	token = bytes.TrimSpace(token)
	if err != nil || len(token) < 32 {
		fmt.Fprintln(os.Stderr, "Bridge token file missing or invalid.")
		os.Exit(1)
	}
	addr := envDefault("ICLOUD_BRIDGE_LISTEN", ":9443")
	server := &http.Server{Addr: addr, Handler: newBridge(token), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 120 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10, ErrorLog: log.New(io.Discard, "", 0)}
	cert, key := os.Getenv("ICLOUD_BRIDGE_TLS_CERT_FILE"), os.Getenv("ICLOUD_BRIDGE_TLS_KEY_FILE")
	if cert != "" && key != "" {
		err = server.ListenAndServeTLS(cert, key)
	} else {
		host, _, splitErr := net.SplitHostPort(addr)
		ip, parseErr := netip.ParseAddr(host)
		if os.Getenv("ICLOUD_BRIDGE_ALLOW_LOOPBACK_HTTP") != "true" || splitErr != nil || parseErr != nil || !ip.IsLoopback() {
			fmt.Fprintln(os.Stderr, "TLS certificate and key files are required.")
			os.Exit(1)
		}
		err = server.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, "Bridge server failed.")
		os.Exit(1)
	}
}
