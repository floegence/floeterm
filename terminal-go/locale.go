package terminal

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

const localeProbeTimeout = 500 * time.Millisecond

type localeCatalogProbe func(context.Context) ([]string, error)

func applyLocaleFallback(ctx context.Context, env []string, probe localeCatalogProbe) []string {
	if effectiveCharacterLocale(env) != "" || probe == nil {
		return env
	}

	probeCtx, cancel := context.WithTimeout(ctx, localeProbeTimeout)
	defer cancel()
	locales, err := probe(probeCtx)
	if err != nil {
		return env
	}
	fallback := neutralUTF8Locale(locales)
	if fallback == "" {
		return env
	}
	return append(removeEnvKey(env, "LC_CTYPE"), "LC_CTYPE="+fallback)
}

func effectiveCharacterLocale(env []string) string {
	for _, key := range []string{"LC_ALL", "LC_CTYPE", "LANG"} {
		prefix := key + "="
		for index := len(env) - 1; index >= 0; index-- {
			if strings.HasPrefix(env[index], prefix) {
				if value := strings.TrimSpace(strings.TrimPrefix(env[index], prefix)); value != "" {
					return value
				}
				break
			}
		}
	}
	return ""
}

func neutralUTF8Locale(locales []string) string {
	for _, preferred := range []string{"C.UTF-8", "C.utf8"} {
		for _, available := range locales {
			if strings.EqualFold(strings.TrimSpace(available), preferred) {
				return strings.TrimSpace(available)
			}
		}
	}
	return ""
}

func discoverLocaleCatalog(ctx context.Context) ([]string, error) {
	output, err := exec.CommandContext(ctx, "locale", "-a").CombinedOutput()
	if err != nil {
		return nil, err
	}
	return strings.Fields(string(output)), nil
}
