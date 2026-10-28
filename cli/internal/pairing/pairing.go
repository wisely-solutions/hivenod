// Package pairing is the terminal side of pairing (packages/shared/src/pairing.ts): a short code,
// a P-256 key that never leaves this process, and the token the admin's browser seals for it:
// ECDH P-256 -> HKDF-SHA-256 (info "hive-pair:<code>") -> AES-256-GCM (additional data = code).
package pairing

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"time"
)

// Alphabet has no 0/O, 1/I/L. 31 symbols, 8 of them: about 40 bits.
const Alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

const CodeLength = 8

// TTL is how long a code can be confirmed (mirrored in firestore.rules).
const TTL = 15 * time.Minute

// NewCode draws a code with rejection sampling, so every symbol is equally likely.
func NewCode() string {
	n := len(Alphabet)
	limit := 256 - 256%n
	out := make([]byte, 0, CodeLength)
	buf := make([]byte, 16)
	for len(out) < CodeLength {
		_, _ = rand.Read(buf)
		for _, b := range buf {
			if int(b) < limit && len(out) < CodeLength {
				out = append(out, Alphabet[int(b)%n])
			}
		}
	}
	return string(out)
}

// Format: K7QX29PD -> K7QX-29PD.
func Format(code string) string { return code[:4] + "-" + code[4:] }

// URL is the page where an admin confirms the code.
func URL(origin, code string) string {
	return strings.TrimRight(origin, "/") + "/agents/connect?code=" + Format(code)
}

// Path of the pairing document.
func Path(code string) string { return "pairings/" + code }

// Keys is the terminal's key pair; the private key stays in memory.
type Keys struct {
	PublicKey string // raw P-256 point, base64url
	private   *ecdh.PrivateKey
}

// NewKeys makes a fresh key pair.
func NewKeys() (*Keys, error) {
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return &Keys{PublicKey: b64(k.PublicKey().Bytes()), private: k}, nil
}

// KeysFromD rebuilds keys from a private scalar (tests).
func KeysFromD(d []byte) (*Keys, error) {
	k, err := ecdh.P256().NewPrivateKey(d)
	if err != nil {
		return nil, err
	}
	return &Keys{PublicKey: b64(k.PublicKey().Bytes()), private: k}, nil
}

// Sealed is what the browser writes.
type Sealed struct {
	Epk string `json:"epk" firestore:"epk"`
	IV  string `json:"iv" firestore:"iv"`
	Ct  string `json:"ct" firestore:"ct"`
}

// ErrOpen means the sealed token does not open with this key and code.
var ErrOpen = errors.New("the token could not be decrypted for this terminal")

// Open decrypts the token the browser sealed for this terminal.
func (k *Keys) Open(s Sealed, code string) (string, error) {
	epk, err1 := unb64(s.Epk)
	iv, err2 := unb64(s.IV)
	ct, err3 := unb64(s.Ct)
	if err1 != nil || err2 != nil || err3 != nil {
		return "", ErrOpen
	}
	peer, err := ecdh.P256().NewPublicKey(epk)
	if err != nil {
		return "", ErrOpen
	}
	secret, err := k.private.ECDH(peer)
	if err != nil {
		return "", ErrOpen
	}
	key, err := hkdf.Key(sha256.New, secret, nil, "hive-pair:"+code, 32)
	if err != nil {
		return "", ErrOpen
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", ErrOpen
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, len(iv))
	if err != nil {
		return "", ErrOpen
	}
	pt, err := gcm.Open(nil, iv, ct, []byte(code))
	if err != nil {
		return "", ErrOpen
	}
	return string(pt), nil
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func unb64(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// Request is the pairing document the terminal creates (no sign-in needed; rules "pairings").
func Request(publicKey, cli, host, folder string) map[string]any {
	return map[string]any{
		"publicKey": publicKey,
		"cli":       clip(cli, 40),
		"host":      clip(host, 80),
		"folder":    clip(folder, 120),
		"status":    "pending",
		"createdAt": map[string]any{"__hive": "serverTime"},
	}
}
