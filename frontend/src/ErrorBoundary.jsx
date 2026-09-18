import React from "react";

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("PulsePoll App Error:", error, errorInfo);
  }

  handleReset = () => {
    localStorage.removeItem("pulsepoll_token");
    localStorage.removeItem("pulsepoll_user");
    window.location.href = "/";
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#f2f3f7",
            fontFamily: "Inter, sans-serif",
            padding: "20px",
            color: "#14172a",
          }}
        >
          <div
            style={{
              maxWidth: "480px",
              width: "100%",
              background: "#ffffff",
              borderRadius: "16px",
              padding: "36px",
              boxShadow: "0 20px 50px rgba(20, 23, 42, 0.1)",
              textAlign: "center",
            }}
          >
            <div
              style={{
                width: "48px",
                height: "48px",
                borderRadius: "50%",
                background: "rgba(196, 64, 47, 0.1)",
                color: "#c4402f",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "24px",
                fontWeight: "bold",
                marginBottom: "16px",
              }}
            >
              !
            </div>
            <h2 style={{ fontSize: "22px", marginBottom: "8px" }}>
              Something went wrong
            </h2>
            <p
              style={{
                color: "#5c6178",
                fontSize: "14px",
                marginBottom: "20px",
                lineHeight: "1.5",
              }}
            >
              An unexpected error occurred while rendering the page.
            </p>
            {this.state.error && (
              <pre
                style={{
                  background: "#f8f9fc",
                  border: "1px solid #dde1e9",
                  borderRadius: "8px",
                  padding: "12px",
                  fontSize: "12px",
                  textAlign: "left",
                  overflowX: "auto",
                  color: "#c4402f",
                  marginBottom: "20px",
                }}
              >
                {this.state.error.message || String(this.state.error)}
              </pre>
            )}
            <div style={{ display: "flex", gap: "12px", justifyContent: "center" }}>
              <button
                onClick={() => window.location.reload()}
                style={{
                  padding: "10px 18px",
                  borderRadius: "8px",
                  border: "1px solid #dde1e9",
                  background: "#ffffff",
                  color: "#14172a",
                  cursor: "pointer",
                  fontWeight: "600",
                }}
              >
                Reload
              </button>
              <button
                onClick={this.handleReset}
                style={{
                  padding: "10px 18px",
                  borderRadius: "8px",
                  border: "none",
                  background: "#d98c2b",
                  color: "#ffffff",
                  cursor: "pointer",
                  fontWeight: "600",
                }}
              >
                Clear Data &amp; Restart
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
