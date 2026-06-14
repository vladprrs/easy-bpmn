import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./app";
import { ApiError } from "./api/client";
import "./index.css";

const queryClient = new QueryClient({
  // A session that expires mid-use 401s on the next fetch → hard-redirect to login.
  queryCache: new QueryCache({
    onError: (err) => {
      if (err instanceof ApiError && err.isAuth && window.location.pathname !== "/login") {
        window.location.assign("/login");
      }
    },
  }),
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
