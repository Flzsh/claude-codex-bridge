You are writing acceptance tests from a contract, without seeing any implementation. Your tests should check what the contract promises, including edge cases and failure modes the implementer might not think of. Do not modify any files — output the test code in your answer.

## The contract
{{CONTRACT}}

## Project test setup
{{TEST_SETUP}}
(Framework, where tests live, how they run, an example existing test if available.)

## Produce
For each acceptance criterion, one or more tests. Also add tests for: invalid input, boundaries, empty data, permissions/auth, and concurrency or idempotency if relevant.

Output each test file as:

### FILE: <path relative to repo root>
```<language>
<complete file contents>
```

Then a short list: which criterion each test covers, and any criterion you could not test and why.
