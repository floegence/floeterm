//go:build !floeterm_native

package nativevt

import "errors"

var ErrUnavailable = errors.New("FloeTerm native VT support is not linked")

type Engine struct{}

func New(uint16, uint16) (*Engine, error) { return nil, ErrUnavailable }
