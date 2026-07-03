# Contributing to oh-my-humanize

Thanks for your interest in contributing. This project uses a lightweight
**vouch** system to decide when automated review should start. Please read this
before opening a PR.

## TL;DR

- **Issues are open to everyone.** File bugs, feature requests, and questions
  freely — they are triaged automatically.
- **Pull requests can be opened by anyone.** A PR whose author is not vouched
  stays open with the `needs-vouch` label until a maintainer reviews it or
  vouches the author. Automated review starts only after the PR receives the
  `vouched` label.

## Who gets automated review

A pull request enters the automated review path when its author is any of:

- a repository collaborator (write access or above), or a bot; or
- listed — without a leading `-` — in [`.github/VOUCHED.td`](.github/VOUCHED.td).

Anyone **denounced** (prefixed with `-` in that file) is still marked
`needs-vouch` and requires explicit maintainer handling.

## Getting vouched

1. Open a [Discussion](../../discussions) (or comment on an existing one)
   describing what you'd like to contribute.
2. A maintainer vouches you by commenting **`!vouch`** (vouches the discussion
   author) or **`!vouch @your-handle`** on that discussion.
3. Once you appear in `.github/VOUCHED.td`, your PR gets the `vouched` label and
   enters automated review.

Maintainers may also `!denounce [@user]` and `!unvouch [@user]`. Only
collaborators with admin/maintain/write can run these commands.

## What happens to your PR

| You are… | Result |
| --- | --- |
| Vouched (or a collaborator) | PR stays open → automated review → human review |
| Not vouched | PR stays open with `needs-vouch` until maintainer review/vouch |
| Denounced | PR stays open with `needs-vouch` for explicit maintainer handling |

Pushing more commits to an open, vouched PR is fine — it remains vouched.

## The VOUCHED.td file

[`.github/VOUCHED.td`](.github/VOUCHED.td) is the source of truth: one handle per
line, sorted alphabetically, optionally `platform:handle`, with `-` marking a
denouncement and an optional reason after the handle. The format follows
[mitchellh/vouch](https://github.com/mitchellh/vouch); the denouncement list is
intentionally public so other projects can reuse our prior knowledge of bad
actors.
