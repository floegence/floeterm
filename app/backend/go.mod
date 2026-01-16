module github.com/floegence/floeterm/app/backend

go 1.25.6

require (
	github.com/coder/websocket v1.8.14
	github.com/floegence/floeterm/terminal-go v0.0.0
)

require github.com/creack/pty v1.1.21 // indirect

replace github.com/floegence/floeterm/terminal-go => ../../terminal-go
