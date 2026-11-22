# Notification lifecycle model

VaultQuest keeps notification presentation in the client notification center.
The pure model in `lib/notification-dedup.ts` is the integration boundary for
vault, prize-draw, action, and recovery flows. It is deliberately independent
of React so producers can be tested without rendering a dashboard.

> Preference-aware delivery (optional alerts can be muted; mandatory
> security/lifecycle alerts always deliver, with an audit trail) is documented
> in [`NOTIFICATION_ROUTING.md`](./NOTIFICATION_ROUTING.md).

## Dispatching a lifecycle event

Create the input with the helper matching the lifecycle transition, then pass
it to `dispatchAlert` from `useNotificationCenter`:

```ts
dispatchAlert(createCompletedActionNotification({
  actionType: "deposit",
  walletAddress,
  actionId,
  txHash,
}));
```

Available helpers cover action failures, approvals, completed actions, and
recovery states. Each sets a relevant deep link and an event identifier. Use a
stable action, transaction, proposal, or recovery identifier as `eventId` (or
the helper's corresponding id parameter). Re-delivery and retry of the same
event then update one notification instead of adding another.

## Targeting and privacy

Pass the connected account to `NotificationProvider` through `viewer`:

```tsx
<NotificationProvider
  scopeKey={`${walletAddress}@${network}`}
  viewer={{ walletAddress, role: "user" }}
>
  {children}
</NotificationProvider>
```

Wallet-scoped notifications require an exact, case-insensitive recipient
match. Private notifications require a recipient match even when they are not
wallet-scoped. Admin-scoped or admin-targeted notifications require
`role: "admin"`. Alerts that fail these checks are discarded before they enter
client state or browser storage. `scopeKey` must remain wallet-and-network
specific so persisted read and dismissed state cannot cross accounts.

## Read state and links

Notifications start unread. `markRead`, `markUnread`, and `markAllRead` update
the current session; read and dismissed ids persist beneath the scoped browser
storage key. Use `deepLink` and `actionLabel` for a safe internal workflow
route, such as the action activity view or recovery tab. Do not put private
payloads in a URL; link by the opaque action or proposal id and enforce access
again at the destination API.

## Validation

Run the focused suite after changing notification producers or the model:

```bash
pnpm exec vitest run tests/notification-dedup.test.tsx
```
