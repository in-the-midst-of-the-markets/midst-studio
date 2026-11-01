"use client";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#101010",
          color: "#ffffff",
          fontFamily: "Montserrat, system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: 480, padding: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ color: "#c4b4c6", marginBottom: 24 }}>
            An unexpected error occurred. Please try refreshing the page.
          </p>
          {error.digest && <p style={{ color: "#52525b", fontSize: 12, marginBottom: 16 }}>Error ID: {error.digest}</p>}
          <button
            onClick={reset}
            style={{
              padding: "10px 24px",
              backgroundColor: "#9546de",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            Refresh Page
          </button>
        </div>
      </body>
    </html>
  );
}
