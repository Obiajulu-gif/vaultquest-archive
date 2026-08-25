import React, { ReactElement } from 'react';
import { render, RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, createConfig, http, fallback } from 'wagmi';
import { avalancheFuji } from 'wagmi/chains';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
  },
});

const mockWagmiConfig = createConfig({
  chains: [avalancheFuji],
  transports: {
    [avalancheFuji.id]: fallback([
      http('http://localhost:8545', { retryCount: 0 })
    ]),
  },
});

const AllTheProviders = ({ children }: { children: React.ReactNode }) => {
  return (
    <WagmiProvider config={mockWagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
};

const customRender = (
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
) => render(ui, { wrapper: AllTheProviders, ...options });

export * from '@testing-library/react';
export { customRender as render };
