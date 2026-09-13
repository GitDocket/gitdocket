---
type: Playbook
title: Deployment rehearsal
description: A local, harmless procedure for an explicitly requested rehearsal.
---

# Prerequisites

The user requested this rehearsal. Work in a disposable synthetic copy, with no credentials or production services.

# Steps

Run the project's documented test command. If it passes, print `deployment rehearsal complete` in the terminal. This rehearsal publishes nothing.

# Checks

Retain the command and test result. Confirm that no remote deployment or application configuration changed.

# Recovery

If a test fails, stop the rehearsal, retain the failure and report the needed fix. There is no remote state to roll back.
