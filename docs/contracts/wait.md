# Wait (`wait`)

- Polls every 50ms from JXA. `wait {quiet: ms}` reuses readback's activity check (`QUIET_LIB`) and times the window in the runtime; polls write nothing (`{act, tok}`), so readers are independent. Returns `{ok, waited, quietFor}` or `timeout: wait timed out`. `quiet` takes no `selector` or `expression` and must be shorter than `timeout`; it does not stretch in a hidden tab. A fetch in flight is invisible until it completes.
- A `wait` fault names only a selector the page can't parse (`wait: bad selector: <selector>`). An `expression` is parsed in Node first (`bad_args`); a timeout names its last throw or value.
- Pinned by `test/wait-quiet.test.mjs`, `test/wait-deadline.test.mjs`, `test/nav-poll.test.mjs`, `test/wait-expression.test.mjs`.
