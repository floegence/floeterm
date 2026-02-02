package terminal

import "time"

// ManagerConfig defines defaults used for all sessions created by a manager.
type ManagerConfig struct {
	Logger                        Logger
	EnvProvider                   ShellEnvProvider
	ShellResolver                 ShellResolver
	ShellArgsProvider             ShellArgsProvider
	ShellInitWriter               ShellInitWriter
	HistoryFilter                 HistoryFilter
	HistoryBufferSize             int
	InputWindow                   time.Duration
	InitialResizeSuppressDuration time.Duration
	ResizeSuppressDuration        time.Duration
	TerminalEnv                   TerminalEnv
}

// TerminalEnv defines environment variables applied to every PTY session.
type TerminalEnv struct {
	Term               string
	ColorTerm          string
	Lang               string
	LcAll              string
	TermProgram        string
	TermProgramVersion string
	Terminfo           string
	TermFeatures       string
}

// DefaultTerminalEnv returns a baseline environment configuration.
func DefaultTerminalEnv() TerminalEnv {
	return TerminalEnv{
		Term:               "xterm-256color",
		ColorTerm:          "truecolor",
		Lang:               "en_US.UTF-8",
		LcAll:              "en_US.UTF-8",
		TermProgram:        "floeterm",
		TermProgramVersion: "0.3.2",
		Terminfo:           "/usr/share/terminfo",
		TermFeatures:       "256color:altscreen:mouse",
	}
}

// applyDefaults ensures unset ManagerConfig fields are filled with safe defaults.
func (cfg ManagerConfig) applyDefaults() ManagerConfig {
	if cfg.Logger == nil {
		cfg.Logger = NopLogger{}
	}
	if cfg.EnvProvider == nil {
		cfg.EnvProvider = DefaultEnvProvider{}
	}
	if cfg.ShellResolver == nil {
		cfg.ShellResolver = DefaultShellResolver{}
	}
	if cfg.ShellArgsProvider == nil {
		cfg.ShellArgsProvider = DefaultShellArgsProvider{}
	}
	if cfg.ShellInitWriter == nil {
		cfg.ShellInitWriter = DefaultShellInitWriter{}
	}
	if cfg.HistoryFilter == nil {
		cfg.HistoryFilter = DefaultHistoryFilter{}
	}
	if cfg.HistoryBufferSize <= 0 {
		cfg.HistoryBufferSize = 2048
	}
	if cfg.InputWindow <= 0 {
		cfg.InputWindow = 10 * time.Millisecond
	}
	if cfg.InitialResizeSuppressDuration <= 0 {
		cfg.InitialResizeSuppressDuration = 500 * time.Millisecond
	}
	if cfg.ResizeSuppressDuration <= 0 {
		cfg.ResizeSuppressDuration = 200 * time.Millisecond
	}
	if cfg.TerminalEnv == (TerminalEnv{}) {
		cfg.TerminalEnv = DefaultTerminalEnv()
	}

	return cfg
}

type sessionConfig struct {
	logger                        Logger
	envProvider                   ShellEnvProvider
	shellResolver                 ShellResolver
	shellArgsProvider             ShellArgsProvider
	shellInitWriter               ShellInitWriter
	historyFilter                 HistoryFilter
	historyBufferSize             int
	inputWindow                   time.Duration
	initialResizeSuppressDuration time.Duration
	resizeSuppressDuration        time.Duration
	terminalEnv                   TerminalEnv
}

func newSessionConfig(cfg ManagerConfig) sessionConfig {
	cfg = cfg.applyDefaults()
	return sessionConfig{
		logger:                        cfg.Logger,
		envProvider:                   cfg.EnvProvider,
		shellResolver:                 cfg.ShellResolver,
		shellArgsProvider:             cfg.ShellArgsProvider,
		shellInitWriter:               cfg.ShellInitWriter,
		historyFilter:                 cfg.HistoryFilter,
		historyBufferSize:             cfg.HistoryBufferSize,
		inputWindow:                   cfg.InputWindow,
		initialResizeSuppressDuration: cfg.InitialResizeSuppressDuration,
		resizeSuppressDuration:        cfg.ResizeSuppressDuration,
		terminalEnv:                   cfg.TerminalEnv,
	}
}
