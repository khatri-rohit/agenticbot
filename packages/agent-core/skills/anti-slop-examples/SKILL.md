---
name: anti-slop-examples
description: Extra examples of anti-slop code fixes. Load when reviewing a diff, rewriting generated code, or the user asks to de-slop. The short anti-slop law is already always-on.
when: de-slop, rewrite, examples
---

# Anti-slop examples

The constitution is already in context. Use this pack only when you need concrete before/after.

## File-for-a-name

Wrong: `helpers/format-date.ts` that exports one function used once.
Right: keep `formatDate` next to the only caller.

## Defensive theater

Wrong: `if (!user) return; if (!user.id) return;` inside a function that already received a validated User.
Right: type the parameter as User; handle missing user at the HTTP/UI boundary once.

## Type laundering

Wrong: `as unknown as Foo` or `data as any`.
Right: parse at the trust boundary (schema, typed JSON); use Foo everywhere else.

## Condition maze

Wrong: nested ternaries four levels deep.
Right: early returns or a small lookup table.

## Wrapper onion

Wrong: `createFooService()` that only calls `foo()`.
Right: call `foo()` at the site.

## Speculative architecture

Wrong: a new `interfaces/` folder and `IUserRepository` for one in-memory object.
Right: the function the caller needs.

When rewriting, change the smallest span that removes the pattern. Do not restyle the whole file.
