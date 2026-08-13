//go:build !floeterm_native

package terminal

import "errors"

func newProductSemanticEngine(int, int) (SemanticEngine, error) {
	return nil, errors.New("native semantic engine unavailable")
}
