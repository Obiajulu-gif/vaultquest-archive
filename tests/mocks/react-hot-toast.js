// Test stub. `react-hot-toast` is imported by app code but is not a declared
// dependency, so it cannot be resolved under vitest. Tests that care about
// toasts can still vi.mock("react-hot-toast") on top of this.
const noop = () => "";
export const toast = Object.assign(noop, { success: noop, error: noop, loading: noop, dismiss: noop });
export const Toaster = () => null;
export default toast;
