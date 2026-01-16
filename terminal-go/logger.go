package terminal

import (
	"fmt"
	"log"
	"os"
	"strings"
	"time"
)

// LogLevel controls which log messages are emitted by the default logger.
type LogLevel int

const (
	LogDebug LogLevel = iota
	LogInfo
	LogWarn
	LogError
)

// Logger is a minimal structured logging interface used by this package.
//
// The implementation is intentionally tiny so integrators can plug in
// their own logger without pulling extra dependencies.
type Logger interface {
	Debug(msg string, kv ...any)
	Info(msg string, kv ...any)
	Warn(msg string, kv ...any)
	Error(msg string, kv ...any)
}

// NopLogger drops all log messages.
type NopLogger struct{}

func (NopLogger) Debug(string, ...any) {}
func (NopLogger) Info(string, ...any)  {}
func (NopLogger) Warn(string, ...any)  {}
func (NopLogger) Error(string, ...any) {}

// StdLogger writes log messages to stdout with a simple level filter.
type StdLogger struct {
	logger   *log.Logger
	minLevel LogLevel
}

// NewStdLogger returns a logger that prints to stdout with timestamps.
func NewStdLogger(minLevel LogLevel) *StdLogger {
	return &StdLogger{
		logger:   log.New(os.Stdout, "", log.LstdFlags),
		minLevel: minLevel,
	}
}

func (l *StdLogger) Debug(msg string, kv ...any) { l.log(LogDebug, "DEBUG", msg, kv...) }
func (l *StdLogger) Info(msg string, kv ...any)  { l.log(LogInfo, "INFO", msg, kv...) }
func (l *StdLogger) Warn(msg string, kv ...any)  { l.log(LogWarn, "WARN", msg, kv...) }
func (l *StdLogger) Error(msg string, kv ...any) { l.log(LogError, "ERROR", msg, kv...) }

func (l *StdLogger) log(level LogLevel, label string, msg string, kv ...any) {
	if l == nil || l.logger == nil {
		return
	}
	if level < l.minLevel {
		return
	}

	timestamp := time.Now().Format(time.RFC3339)
	payload := msg
	if len(kv) > 0 {
		payload = fmt.Sprintf("%s %s", msg, formatKV(kv...))
	}

	l.logger.Printf("%s [%s] %s", timestamp, label, payload)
}

func formatKV(kv ...any) string {
	if len(kv) == 0 {
		return ""
	}

	pairs := make([]string, 0, (len(kv)+1)/2)
	for i := 0; i < len(kv); i += 2 {
		key := kv[i]
		var value any
		if i+1 < len(kv) {
			value = kv[i+1]
		}
		pairs = append(pairs, fmt.Sprintf("%v=%v", key, value))
	}

	return strings.Join(pairs, " ")
}
