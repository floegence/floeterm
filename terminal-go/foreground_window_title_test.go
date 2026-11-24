package terminal

import "testing"

func TestForegroundWindowTitleFollowsCommandBoundaries(t *testing.T) {
	session := newExecutionContextTestSession()
	check := func(want string) {
		t.Helper()
		info := session.ToSessionInfo()
		if got := info.ForegroundWindowTitle; got != want || info.Name != "project" {
			t.Fatalf("window title %q, session name %q, want %q", got, info.Name, want)
		}
	}
	session.checkShellIntegrationChange([]byte("\x1b]2;shell\a"))
	session.updateForegroundCommand(ForegroundCommandRunning, "pi")
	check("")
	session.checkShellIntegrationChange([]byte("visible text\x1b]0;2;not a prefix"))
	session.checkShellIntegrationChange([]byte("\x1b\\"))
	check("2;not a prefix")
	session.checkShellIntegrationChange([]byte("\x1b]2;\a"))
	check("")
	session.checkShellIntegrationChange([]byte("\x1b]2;old\a\x1b]133;D\a\x1b]633;P;FloetermProgram=codex\a\x1b]133;C\a"))
	check("")
	session.checkShellIntegrationChange([]byte("\x1b]2;new thread\a"))
	check("new thread")
	session.updateForegroundCommand(ForegroundCommandIdle, "")
	check("")
}
