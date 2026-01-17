package server

import (
	"math"
	"sync"
	"time"
)

type byteRateLimiter struct {
	rateBytesPerSec float64
	burstBytes      float64

	mu          sync.Mutex
	buckets     map[string]*byteTokenBucket
	lastCleanup time.Time
}

type byteTokenBucket struct {
	tokens    float64
	lastRefill time.Time
	lastSeen   time.Time
}

func newByteRateLimiter(rateBytesPerSec, burstBytes int) *byteRateLimiter {
	return &byteRateLimiter{
		rateBytesPerSec: math.Max(1, float64(rateBytesPerSec)),
		burstBytes:      math.Max(1, float64(burstBytes)),
		buckets:         make(map[string]*byteTokenBucket),
		lastCleanup:     time.Now(),
	}
}

func (l *byteRateLimiter) Allow(key string, costBytes int, now time.Time) bool {
	if l == nil {
		return true
	}
	if key == "" {
		return false
	}
	if costBytes <= 0 {
		return true
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	l.cleanupLocked(now)

	b := l.buckets[key]
	if b == nil {
		b = &byteTokenBucket{
			tokens:     l.burstBytes,
			lastRefill: now,
			lastSeen:   now,
		}
		l.buckets[key] = b
	}

	b.lastSeen = now
	elapsed := now.Sub(b.lastRefill).Seconds()
	if elapsed > 0 {
		b.tokens = math.Min(l.burstBytes, b.tokens+elapsed*l.rateBytesPerSec)
		b.lastRefill = now
	}

	cost := float64(costBytes)
	if b.tokens < cost {
		return false
	}
	b.tokens -= cost
	return true
}

func (l *byteRateLimiter) cleanupLocked(now time.Time) {
	// Best-effort cleanup to avoid unbounded key growth.
	if now.Sub(l.lastCleanup) < 2*time.Minute {
		return
	}
	l.lastCleanup = now

	const idleTTL = 10 * time.Minute
	for k, b := range l.buckets {
		if b == nil || now.Sub(b.lastSeen) > idleTTL {
			delete(l.buckets, k)
		}
	}
}

