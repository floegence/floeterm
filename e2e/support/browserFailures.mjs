const isExpectedDriverDiagnostic = text => (
  /^\[\.WebGL-[^\]]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels/.test(text)
);

export const captureBrowserFailures = page => {
  const failures = [];
  page.on('console', message => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    const text = message.text();
    if (isExpectedDriverDiagnostic(text)) return;
    failures.push(`console:${message.type()}:${text}`);
  });
  page.on('pageerror', error => failures.push(`pageerror:${error.message}`));
  return failures;
};
