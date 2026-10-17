import type { AppProps } from "next/app";
import "../styles/globals.css";
import { ThemeProvider } from "../components/themeToggle";
import { NetworkProvider } from "../context/NetworkContext";
import { WalletProvider } from "../context/WalletContext";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { GlobalSearchModal } from "../components/GlobalSearchModal";
import { OfflineBanner } from "../components/OfflineBanner";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <NetworkProvider>
          <WalletProvider>
            <OfflineBanner />
            <Component {...pageProps} />
            {/* Mounted app-wide so the search shortcut (Ctrl+K / Cmd+K) works on every page. */}
            <GlobalSearchModal />
          </WalletProvider>
        </NetworkProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
