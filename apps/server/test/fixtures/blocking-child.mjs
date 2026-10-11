// A child that never answers (T-A-083; used by `test/branding/job-runner.test.ts` only). The first
// message it receives starts a loop that never yields, the way a native image call that never returns
// would: no await, no timer, nothing for the event loop to run, so it cannot even notice that its
// parent disconnected. The runner has to kill it. It burns a core on purpose: after the kill the test
// checks that the process is gone, so nothing keeps burning.
process.on('message', () => {
  for (;;) {
    // Busy on purpose.
  }
});
