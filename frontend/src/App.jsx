import { useEffect, useRef, useState } from "react";
import "./App.css";

/*
 * DEPLOYMENT CONFIGURATION
 *
 * Do NOT use:
 * http://127.0.0.1:8080
 *
 * In production, requests go through the same Vercel domain.
 */

const BACKEND_TUNNEL_URL = "https://legislate-geiger-litigator.ngrok-free.dev";
const API_URL = (import.meta.env.VITE_API_URL || BACKEND_TUNNEL_URL).replace(/\/$/, "");

// Auto-inject ngrok header so browser/fetch requests pass through ngrok free tunnel smoothly
const _origFetch = window.fetch;
window.fetch = (url, options = {}) => {
  const headers = new Headers(options.headers || {});
  if (!headers.has("ngrok-skip-browser-warning")) {
    headers.set("ngrok-skip-browser-warning", "69420");
  }
  return _origFetch(url, { ...options, headers });
};

const WS_URL = (() => {
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL;
  }
  if (API_URL.startsWith("http://")) {
    return API_URL.replace(/^http:/, "ws:") + "/ws";
  }
  if (API_URL.startsWith("https://")) {
    return API_URL.replace(/^https:/, "wss:") + "/ws";
  }
  return window.location.protocol === "https:"
    ? `wss://${window.location.host}/ws`
    : `ws://${window.location.host}/ws`;
})();

function getOrCreateVoterId() {
  let vid = localStorage.getItem("pulsepoll_voter_id");
  if (!vid) {
    vid = "voter_" + Math.random().toString(36).substring(2, 11) + "_" + Date.now().toString(36);
    localStorage.setItem("pulsepoll_voter_id", vid);
  }
  return vid;
}

function hasVotedInPoll(pollId) {
  if (!pollId) return false;
  try {
    const votedList = JSON.parse(localStorage.getItem("pulsepoll_voted_polls") || "[]");
    return votedList.includes(String(pollId));
  } catch {
    return false;
  }
}

function markPollAsVotedLocally(pollId) {
  try {
    const votedList = JSON.parse(localStorage.getItem("pulsepoll_voted_polls") || "[]");
    if (!votedList.includes(String(pollId))) {
      votedList.push(String(pollId));
      localStorage.setItem("pulsepoll_voted_polls", JSON.stringify(votedList));
    }
  } catch {
    // ignore
  }
}

function App() {
  const [token, setToken] = useState(
    () => localStorage.getItem("pulsepoll_token") || ""
  );

  const [page, setPage] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("poll")) return "poll";
    return localStorage.getItem("pulsepoll_token") ? "dashboard" : "login";
  });

  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(
        localStorage.getItem("pulsepoll_user") || "null"
      );
    } catch {
      return null;
    }
  });

  const [polls, setPolls] = useState([]);
  const [selectedPoll, setSelectedPoll] = useState(null);
  const [selectedOption, setSelectedOption] = useState(null);
  const [shareModalPoll, setShareModalPoll] = useState(null);
  const [copiedLink, setCopiedLink] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [realtimeConnected, setRealtimeConnected] = useState(false);

  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const [profileOpen, setProfileOpen] = useState(false);

  const socketRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  const [loginForm, setLoginForm] = useState({
    email: "",
    password: "",
  });

  const [signupForm, setSignupForm] = useState({
    name: "",
    email: "",
    password: "",
  });

  const [pollForm, setPollForm] = useState({
    question: "",
    options: ["", ""],
    imageUrls: ["", ""],
  });

  const [showImages, setShowImages] = useState(false);
  const [showGoogleModal, setShowGoogleModal] = useState(false);
  const [customGoogleEmail, setCustomGoogleEmail] = useState("");

  // --------------------------------------------------
  // INITIAL LOAD & DEEP LINK HANDLING
  // --------------------------------------------------

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pollId = params.get("poll");

    if (pollId) {
      openPoll(pollId, false);
    } else if (token) {
      loadPolls(token);
    }

    // Connect WebSocket regardless of login state so audience sees live updates
    connectWebSocket();

    const handlePopState = () => {
      const currentParams = new URLSearchParams(window.location.search);
      const currentPollId = currentParams.get("poll");
      if (currentPollId) {
        openPoll(currentPollId, false);
      } else {
        setSelectedPoll(null);
        setPage(token ? "dashboard" : "login");
      }
    };

    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function connectWebSocket() {
    try {
      if (socketRef.current && (socketRef.current.readyState === WebSocket.OPEN || socketRef.current.readyState === WebSocket.CONNECTING)) {
        return;
      }
      if (socketRef.current) {
        socketRef.current.close();
      }

      const socket = new WebSocket(WS_URL);
      socketRef.current = socket;

      socket.onopen = () => {
        setRealtimeConnected(true);
      };

      // --------------------------------------------------
      // WEBSOCKET MESSAGE
      // --------------------------------------------------

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          // FORMAT 1: VOTE
          if (message.type === "vote" && message.pollId) {
            updateVoteFromRealtime(message);
            return;
          }

          // FORMAT 2: FULL POLL UPDATE
          if (
            message.type === "poll_updated" &&
            message.poll
          ) {
            updatePollFromRealtime(message.poll);
            return;
          }

          // FORMAT 3: BACKEND SENDS POLL DIRECTLY
          if (message.poll) {
            updatePollFromRealtime(message.poll);
            return;
          }
        } catch (err) {
          console.error("Invalid WebSocket message:", err);
        }
      };

      socket.onerror = () => {
        setRealtimeConnected(false);
      };

      socket.onclose = () => {
        setRealtimeConnected(false);
        // Automatic retry after 3 seconds for continuous realtime
        if (!reconnectTimeoutRef.current) {
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null;
            connectWebSocket();
          }, 3000);
        }
      };
    } catch (err) {
      console.error("WebSocket connection error:", err);
      setRealtimeConnected(false);
    }
  }


  // --------------------------------------------------
  // APPLY REALTIME VOTE
  // --------------------------------------------------

  function updateVoteFromRealtime(message) {
    const pollId = String(message.pollId);

    const incomingVotes = Array.isArray(message.votes)
      ? message.votes.map((value) => Number(value || 0))
      : null;

    if (!incomingVotes) {
      return;
    }

    // UPDATE DASHBOARD POLLS
    setPolls((currentPolls) => {
      const pollExists = currentPolls.some(
        (poll) => String(poll.id) === pollId
      );

      if (!pollExists) {
        return currentPolls;
      }

      return currentPolls.map((poll) => {
        if (String(poll.id) !== pollId) {
          return poll;
        }

        return {
          ...poll,
          votes: [...incomingVotes],
        };
      });
    });

    // UPDATE CURRENTLY OPEN POLL
    setSelectedPoll((currentPoll) => {
      if (!currentPoll) {
        return currentPoll;
      }

      if (String(currentPoll.id) !== pollId) {
        return currentPoll;
      }

      return {
        ...currentPoll,
        votes: [...incomingVotes],
      };
    });
  }

  // --------------------------------------------------
  // APPLY FULL REALTIME POLL
  // --------------------------------------------------

  function updatePollFromRealtime(updatedPoll) {
    if (!updatedPoll || !updatedPoll.id) {
      return;
    }

    setPolls((currentPolls) => {
      const exists = currentPolls.some(
        (poll) =>
          String(poll.id) === String(updatedPoll.id)
      );

      if (!exists) {
        return [updatedPoll, ...currentPolls];
      }

      return currentPolls.map((poll) =>
        String(poll.id) === String(updatedPoll.id)
          ? {
              ...poll,
              ...updatedPoll,
              votes: Array.isArray(updatedPoll.votes)
                ? [...updatedPoll.votes]
                : poll.votes,
            }
          : poll
      );
    });

    setSelectedPoll((currentPoll) => {
      if (
        currentPoll &&
        String(currentPoll.id) ===
          String(updatedPoll.id)
      ) {
        return {
          ...currentPoll,
          ...updatedPoll,
          votes: Array.isArray(updatedPoll.votes)
            ? [...updatedPoll.votes]
            : currentPoll.votes,
        };
      }

      return currentPoll;
    });
  }

  // --------------------------------------------------
  // TOASTS
  // --------------------------------------------------

  function showError(message) {
    setError(message);
    setSuccess("");

    setTimeout(() => {
      setError("");
    }, 4000);
  }

  function showSuccess(message) {
    setSuccess(message);
    setError("");

    setTimeout(() => {
      setSuccess("");
    }, 4000);
  }

  // --------------------------------------------------
  // LOGIN STORAGE
  // --------------------------------------------------

  function saveLogin(loginToken, loginUser = null) {
    localStorage.setItem(
      "pulsepoll_token",
      loginToken
    );

    setToken(loginToken);

    if (loginUser) {
      localStorage.setItem(
        "pulsepoll_user",
        JSON.stringify(loginUser)
      );

      setUser(loginUser);
    }
  }

  function logout() {
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }

    localStorage.removeItem("pulsepoll_token");
    localStorage.removeItem("pulsepoll_user");

    setToken("");
    setUser(null);
    setPolls([]);
    setSelectedPoll(null);
    setSelectedOption(null);
    setRealtimeConnected(false);
    setPage("login");

    setSuccess("");
    setError("");
  }

  // --------------------------------------------------
  // SAFE RESPONSE PARSER
  // --------------------------------------------------

  async function parseJsonResponse(response) {
    const contentType = response.headers.get("content-type") || "";
    let data = null;

    if (contentType.includes("application/json")) {
      try {
        data = await response.json();
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      if (data && data.error) {
        throw new Error(data.error);
      }
      if (response.status === 502 || response.status === 503 || response.status === 504) {
        throw new Error(
          "Backend server is offline or unreachable. Please start the Go backend server."
        );
      }
      if (response.status === 404 || response.status === 405) {
        throw new Error(
          "Backend server is not connected or unreachable. Ensure your backend is running and VITE_API_URL is configured."
        );
      }
      throw new Error(`Server returned status ${response.status}.`);
    }

    if (!data) {
      throw new Error(
        "Received an HTML/non-JSON response from the server. Ensure the backend server is running."
      );
    }

    return data;
  }

  // --------------------------------------------------
  // LOGIN
  // --------------------------------------------------

  async function login(event) {
    event.preventDefault();

    setLoading(true);
    setError("");

    try {
      const response = await fetch(
        `${API_URL}/api/auth/login`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: loginForm.email.trim(),
            password: loginForm.password,
          }),
        }
      );

      const data = await parseJsonResponse(response);

      if (!data.token) {
        throw new Error(
          "Login succeeded but no token was returned"
        );
      }

      const loggedUser =
        data.user || {
          email: loginForm.email.trim(),
        };

      saveLogin(data.token, loggedUser);

      setLoginForm({
        email: "",
        password: "",
      });

      setPage("dashboard");

      showSuccess("Login successful");

      await loadPolls(data.token);
    } catch (err) {
      console.error("Login error:", err);

      showError(
        err.message === "Failed to fetch"
          ? "Cannot connect to the backend. Please try again."
          : err.message
      );
    } finally {
      setLoading(false);
    }
  }

  // --------------------------------------------------
  // GOOGLE AUTHENTICATION
  // --------------------------------------------------

  async function handleGoogleLogin(googleData) {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(
        `${API_URL}/api/auth/google`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(googleData),
        }
      );

      const data = await parseJsonResponse(response);

      if (!data.token) {
        throw new Error(
          "Google sign-in succeeded but no token was returned"
        );
      }

      saveLogin(data.token, data.user);
      setShowGoogleModal(false);
      setPage("dashboard");
      showSuccess("Signed in with Google!");
      await loadPolls(data.token);
    } catch (err) {
      console.error("Google sign-in error:", err);
      showError(
        err.message === "Failed to fetch"
          ? "Cannot connect to backend. Please try again."
          : err.message
      );
    } finally {
      setLoading(false);
    }
  }

  function triggerGoogleAuth() {
    const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
    if (googleClientId && window.google && window.google.accounts) {
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: (response) => {
          if (response.credential) {
            handleGoogleLogin({ credential: response.credential });
          }
        },
      });
      window.google.accounts.id.prompt();
      return;
    }

    setShowGoogleModal(true);
  }

  // --------------------------------------------------
  // SIGNUP
  // --------------------------------------------------

  async function signup(event) {
    event.preventDefault();

    if (!signupForm.name.trim()) {
      showError("Please enter your name");
      return;
    }

    if (!signupForm.email.trim()) {
      showError("Please enter your email");
      return;
    }

    if (signupForm.password.length < 6) {
      showError(
        "Password must contain at least 6 characters"
      );
      return;
    }

    setLoading(true);
    setError("");

    try {
      const response = await fetch(
        `${API_URL}/api/auth/signup`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: signupForm.name.trim(),
            email: signupForm.email.trim(),
            password: signupForm.password,
          }),
        }
      );

      await parseJsonResponse(response);

      setSignupForm({
        name: "",
        email: "",
        password: "",
      });

      setPage("login");

      showSuccess(
        "Account created successfully! Please login."
      );
    } catch (err) {
      console.error("Signup error:", err);

      showError(
        err.message === "Failed to fetch"
          ? "Cannot connect to the backend. Please try again."
          : err.message
      );
    } finally {
      setLoading(false);
    }
  }

  // --------------------------------------------------
  // LOAD POLLS
  // --------------------------------------------------

  async function loadPolls(currentToken = token) {
    try {
      const headers = {};

      if (currentToken) {
        headers.Authorization =
          `Bearer ${currentToken}`;
      }

      const response = await fetch(
        `${API_URL}/api/polls/`,
        {
          headers,
        }
      );

      const data = await parseJsonResponse(response);

      if (Array.isArray(data)) {
        setPolls(data);
      } else if (Array.isArray(data.polls)) {
        setPolls(data.polls);
      } else if (data.poll) {
        setPolls([data.poll]);
      } else {
        setPolls([]);
      }
    } catch (err) {
      console.error("Load polls error:", err);

      if (err.message === "Failed to fetch") {
        showError(
          "Cannot connect to the backend. Please try again."
        );
      } else {
        showError(err.message);
      }
    }
  }

  // --------------------------------------------------
  // CREATE POLL OPTIONS
  // --------------------------------------------------

  function addOption() {
    if (pollForm.options.length >= 10) {
      showError(
        "Maximum 10 options are allowed"
      );
      return;
    }

    setPollForm({
      ...pollForm,
      options: [...pollForm.options, ""],
      imageUrls: [...(pollForm.imageUrls || []), ""],
    });
  }

  function removeOption(index) {
    if (pollForm.options.length <= 2) {
      showError(
        "A poll needs at least 2 options"
      );
      return;
    }

    const newOptions = pollForm.options.filter((_, i) => i !== index);
    const newImageUrls = (pollForm.imageUrls || []).filter((_, i) => i !== index);

    setPollForm({
      ...pollForm,
      options: newOptions,
      imageUrls: newImageUrls,
    });
  }

  function updateOption(index, value) {
    const newOptions = [...pollForm.options];
    newOptions[index] = value;
    setPollForm({ ...pollForm, options: newOptions });
  }

  function updateImageUrl(index, value) {
    const newUrls = [...(pollForm.imageUrls || [])];
    // Ensure array is long enough
    while (newUrls.length <= index) newUrls.push("");
    newUrls[index] = value;
    setPollForm({ ...pollForm, imageUrls: newUrls });
  }

  // --------------------------------------------------
  // CREATE POLL
  // --------------------------------------------------

  async function createPoll(event) {
    event.preventDefault();

    const question =
      pollForm.question.trim();

    const cleanOptions =
      pollForm.options.map(
        (option) => option.trim()
      );

    if (!question) {
      showError(
        "Question is required"
      );
      return;
    }

    if (cleanOptions.length < 2) {
      showError(
        "At least 2 options are required"
      );
      return;
    }

    if (
      cleanOptions.some(
        (option) => option === ""
      )
    ) {
      showError(
        "Please fill in every option"
      );
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(
        `${API_URL}/api/polls/`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
            Authorization:
              `Bearer ${token}`,
          },
          body: JSON.stringify({
            question,
            options: cleanOptions,
            imageUrls: (pollForm.imageUrls || []).map((u) => u.trim()),
          }),
        }
      );

      await parseJsonResponse(response);

      setPollForm({
        question: "",
        options: ["", ""],
        imageUrls: ["", ""],
      });
      setShowImages(false);

      showSuccess(
        "Poll created successfully!"
      );

      await loadPolls(token);

      setPage("dashboard");
    } catch (err) {
      handleAuthError(err);
    } finally {
      setLoading(false);
    }
  }

  // --------------------------------------------------
  // SHARE & COPY LINK
  // --------------------------------------------------

  function getPollShareUrl(pollId) {
    const base = window.location.origin + window.location.pathname;
    return `${base.replace(/\/$/, "")}/?poll=${pollId}`;
  }

  function copyPollLink(pollId, e) {
    if (e && e.stopPropagation) {
      e.stopPropagation();
    }

    const id = pollId || selectedPoll?.id;
    if (!id) return;

    const url = getPollShareUrl(id);

    const onCopied = () => {
      setCopiedLink(id);
      showSuccess("Poll link copied to clipboard!");
      setTimeout(() => {
        setCopiedLink(null);
      }, 2500);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(url)
        .then(onCopied)
        .catch(() => {
          fallbackCopyText(url, onCopied);
        });
    } else {
      fallbackCopyText(url, onCopied);
    }
  }

  function fallbackCopyText(text, onCopied) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand("copy");
      if (onCopied) onCopied();
    } catch {
      showError("Please copy the poll link manually.");
    }
    document.body.removeChild(textArea);
  }

  // --------------------------------------------------
  // OPEN POLL
  // --------------------------------------------------

  async function openPoll(pollId, updateUrl = true) {
    setLoading(true);

    try {
      const voterId = getOrCreateVoterId();
      const headers = {
        "X-Voter-ID": voterId,
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(
        `${API_URL}/api/polls/${pollId}?voterId=${encodeURIComponent(voterId)}`,
        { headers }
      );

      const data = await parseJsonResponse(response);

      const poll = data.poll || data;

      if (data.hasVoted) {
        markPollAsVotedLocally(pollId);
      }

      setSelectedPoll({
        ...poll,
        hasVoted: Boolean(data.hasVoted || hasVotedInPoll(pollId)),
      });
      setSelectedOption(null);
      setPage("poll");

      if (updateUrl && window.location.search !== `?poll=${pollId}`) {
        window.history.pushState({}, "", `?poll=${pollId}`);
      }
    } catch (err) {
      showError(
        err.message === "Failed to fetch"
          ? "Cannot connect to the backend."
          : err.message
      );
    } finally {
      setLoading(false);
    }
  }

  // --------------------------------------------------
  // VOTE
  // --------------------------------------------------

  async function votePoll() {
    if (!selectedPoll) {
      return;
    }

    if (selectedOption === null) {
      showError("Please select an option");
      return;
    }

    if (selectedPoll.status !== "active") {
      showError("This poll is already closed");
      return;
    }

    setLoading(true);

    try {
      const voterId = getOrCreateVoterId();
      const headers = {
        "Content-Type": "application/json",
        "X-Voter-ID": voterId,
      };

      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(
        `${API_URL}/api/polls/${selectedPoll.id}/vote`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            optionIndex: selectedOption,
            voterId: voterId,
          }),
        }
      );

      const data = await parseJsonResponse(response);

      const updatedPoll = data.poll || null;

      markPollAsVotedLocally(selectedPoll.id);

      if (updatedPoll) {
        updatePollFromRealtime({
          ...updatedPoll,
          hasVoted: true,
        });
      } else {
        setSelectedPoll((current) =>
          current ? { ...current, hasVoted: true } : current
        );
      }

      setSelectedOption(null);

      showSuccess("Vote recorded successfully! Results updated live.");
    } catch (err) {
      if (err.message && err.message.toLowerCase().includes("already voted")) {
        markPollAsVotedLocally(selectedPoll.id);
        setSelectedPoll((current) =>
          current ? { ...current, hasVoted: true } : current
        );
      }
      handleAuthError(err);
    } finally {
      setLoading(false);
    }
  }

  // --------------------------------------------------
  // CLOSE POLL
  // --------------------------------------------------

  async function closePoll(pollId) {
    const confirmed =
      window.confirm(
        "Are you sure you want to close this poll?"
      );

    if (!confirmed) {
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(
        `${API_URL}/api/polls/${pollId}/close`,
        {
          method: "POST",
          headers: {
            Authorization:
              `Bearer ${token}`,
          },
        }
      );

      const data = await parseJsonResponse(response);

      const updatedPoll =
        data.poll;

      if (
        selectedPoll &&
        String(selectedPoll.id) ===
          String(pollId)
      ) {
        setSelectedPoll(
          updatedPoll
        );

        setSelectedOption(null);
      }

      if (updatedPoll) {
        updatePollFromRealtime(
          updatedPoll
        );
      }

      showSuccess(
        "Poll closed successfully!"
      );

      await loadPolls(token);
    } catch (err) {
      handleAuthError(err);
    } finally {
      setLoading(false);
    }
  }

  // --------------------------------------------------
  // AUTH ERROR HANDLING
  // --------------------------------------------------

  function handleAuthError(err) {
    const message =
      err.message || "";

    const lowerMessage =
      message.toLowerCase();

    if (
      lowerMessage.includes(
        "authorization"
      ) ||
      lowerMessage.includes(
        "token"
      ) ||
      lowerMessage.includes(
        "expired"
      )
    ) {
      logout();

      showError(
        "Your session expired. Please login again."
      );

      return;
    }

    if (
      message === "Failed to fetch"
    ) {
      showError(
        "Cannot connect to the backend. Please try again."
      );

      return;
    }

    showError(message);
  }

  // --------------------------------------------------
  // VOTE CALCULATIONS
  // --------------------------------------------------

  function totalVotes(poll) {
    if (
      !poll ||
      !Array.isArray(poll.votes)
    ) {
      return 0;
    }

    return poll.votes.reduce(
      (total, value) =>
        total + Number(value || 0),
      0
    );
  }

  function getPercentage(
    poll,
    index
  ) {
    const total =
      totalVotes(poll);

    if (total === 0) {
      return 0;
    }

    return Math.round(
      (Number(
        poll.votes[index] || 0
      ) /
        total) *
        100
    );
  }

  // --------------------------------------------------
  // JWT USER ID
  // --------------------------------------------------

  function getUserIdFromToken() {
    if (!token) {
      return null;
    }

    try {
      const parts =
        token.split(".");

      if (parts.length !== 3) {
        return null;
      }

      const base64 =
        parts[1]
          .replace(/-/g, "+")
          .replace(/_/g, "/");

      const decoded =
        JSON.parse(
          atob(base64)
        );

      return (
        decoded.user_id ||
        decoded.userId ||
        decoded.id ||
        null
      );
    } catch {
      return null;
    }
  }

  // --------------------------------------------------
  // CHECK POLL CREATOR
  // --------------------------------------------------

  function isCreator(poll) {
    if (!poll) {
      return false;
    }

    const currentUserId =
      user?.id ||
      user?._id ||
      user?.user_id ||
      getUserIdFromToken();

    if (!currentUserId) {
      return false;
    }

    return (
      String(poll.createdBy) ===
      String(currentUserId)
    );
  }

  // --------------------------------------------------
  // LOGIN PAGE
  // --------------------------------------------------

  function renderLogin() {
    return (
      <div className="auth-page">
        <div className="auth-card">

          <div className="logo">
            <div className="logo-icon">
              P
            </div>

            <div>
              <h1>PulsePoll</h1>

              <p>
                Simple. Fast. Opinion matters.
              </p>
            </div>
          </div>

          <h2>
            Welcome back
          </h2>

          <p className="auth-subtitle">
            Login to create and participate in polls.
          </p>

          <button
            type="button"
            className="google-auth-button"
            onClick={triggerGoogleAuth}
            disabled={loading}
          >
            <svg className="google-icon" viewBox="0 0 24 24" width="18" height="18">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
            </svg>
            <span>Continue with Google</span>
          </button>

          <div className="auth-divider">
            <span>or continue with email</span>
          </div>

          <form onSubmit={login}>

            <label>
              Email
            </label>

            <input
              type="email"
              placeholder="Enter your email"
              value={loginForm.email}
              onChange={(e) =>
                setLoginForm({
                  ...loginForm,
                  email:
                    e.target.value,
                })
              }
              required
            />

            <label>
              Password
            </label>

            <input
              type="password"
              placeholder="Enter your password"
              value={
                loginForm.password
              }
              onChange={(e) =>
                setLoginForm({
                  ...loginForm,
                  password:
                    e.target.value,
                })
              }
              required
            />

            <button
              className="primary-button"
              type="submit"
              disabled={loading}
            >
              {loading
                ? "Logging in..."
                : "Login"}
            </button>

          </form>

          <p className="switch-text">
            Don't have an account?{" "}

            <button
              type="button"
              className="link-button"
              onClick={() => {
                setError("");
                setPage("signup");
              }}
            >
              Create account
            </button>
          </p>

        </div>
      </div>
    );
  }

  // --------------------------------------------------
  // SIGNUP PAGE
  // --------------------------------------------------

  function renderSignup() {
    return (
      <div className="auth-page">
        <div className="auth-card">

          <div className="logo">
            <div className="logo-icon">
              P
            </div>

            <div>
              <h1>PulsePoll</h1>

              <p>
                Share your opinion.
              </p>
            </div>
          </div>

          <h2>
            Create account
          </h2>

          <p className="auth-subtitle">
            Join PulsePoll and start creating polls.
          </p>

          <button
            type="button"
            className="google-auth-button"
            onClick={triggerGoogleAuth}
            disabled={loading}
          >
            <svg className="google-icon" viewBox="0 0 24 24" width="18" height="18">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
            </svg>
            <span>Continue with Google</span>
          </button>

          <div className="auth-divider">
            <span>or continue with email</span>
          </div>

          <form onSubmit={signup}>

            <label>
              Name
            </label>

            <input
              type="text"
              placeholder="Enter your name"
              value={signupForm.name}
              onChange={(e) =>
                setSignupForm({
                  ...signupForm,
                  name:
                    e.target.value,
                })
              }
              required
            />

            <label>
              Email
            </label>

            <input
              type="email"
              placeholder="Enter your email"
              value={
                signupForm.email
              }
              onChange={(e) =>
                setSignupForm({
                  ...signupForm,
                  email:
                    e.target.value,
                })
              }
              required
            />

            <label>
              Password
            </label>

            <input
              type="password"
              placeholder="Minimum 6 characters"
              value={
                signupForm.password
              }
              onChange={(e) =>
                setSignupForm({
                  ...signupForm,
                  password:
                    e.target.value,
                })
              }
              minLength={6}
              required
            />

            <button
              className="primary-button"
              type="submit"
              disabled={loading}
            >
              {loading
                ? "Creating account..."
                : "Create account"}
            </button>

          </form>

          <p className="switch-text">
            Already have an account?{" "}

            <button
              type="button"
              className="link-button"
              onClick={() => {
                setError("");
                setPage("login");
              }}
            >
              Login
            </button>
          </p>

        </div>
      </div>
    );
  }

  // --------------------------------------------------
  // SHARE MODAL
  // --------------------------------------------------

  function renderShareModal() {
    if (!shareModalPoll) return null;

    const shareUrl = getPollShareUrl(shareModalPoll.id);
    const isCopied = copiedLink === shareModalPoll.id;

    return (
      <div
        className="modal-backdrop"
        onClick={() => setShareModalPoll(null)}
      >
        <div
          className="modal-card share-modal"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="modal-header">
            <div>
              <span className="eyebrow">LIVE AUDIENCE SHARE</span>
              <h2>{shareModalPoll.question}</h2>
            </div>

            <button
              type="button"
              className="modal-close"
              onClick={() => setShareModalPoll(null)}
              aria-label="Close modal"
            >
              ✕
            </button>
          </div>

          <p className="share-description">
            Anyone with this link or QR code can vote live from any phone or computer with zero login required.
          </p>

          <div className="share-link-box">
            <input
              type="text"
              readOnly
              value={shareUrl}
              className="share-link-input"
              onClick={(e) => e.target.select()}
            />
            <button
              type="button"
              className={
                isCopied
                  ? "primary-button share-copy-btn copied"
                  : "primary-button share-copy-btn"
              }
              onClick={() => copyPollLink(shareModalPoll.id)}
            >
              {isCopied ? "Copied! ✓" : "Copy Link"}
            </button>
          </div>

          <div className="share-qr-section">
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(
                shareUrl
              )}`}
              alt="Poll QR Code"
              className="share-qr-img"
            />
            <span className="share-qr-hint">
              📱 Scan with phone camera to vote directly
            </span>
          </div>

          {typeof navigator !== "undefined" && navigator.share && (
            <button
              type="button"
              className="secondary-button full"
              style={{ marginBottom: "12px" }}
              onClick={() => {
                navigator
                  .share({
                    title: shareModalPoll.question,
                    text: `Vote on: "${shareModalPoll.question}"`,
                    url: shareUrl,
                  })
                  .catch(() => {});
              }}
            >
              📱 Share via Apps (WhatsApp, Telegram, etc.)
            </button>
          )}

          <button
            type="button"
            className="secondary-button full"
            onClick={() => setShareModalPoll(null)}
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  // --------------------------------------------------
  // NAVBAR
  // --------------------------------------------------

  function renderNavbar() {
    const displayName =
      user?.name ||
      user?.email?.split("@")[0] ||
      "Account";

    const initial =
      displayName
        .charAt(0)
        .toUpperCase();

    return (
      <header className="navbar">

        <button
          className="nav-logo"
          onClick={() => {
            if (token) {
              setPage("dashboard");
              loadPolls(token);
            } else {
              setPage("login");
            }
          }}
          aria-label="Go to PulsePoll dashboard"
        >
          <span className="logo-mark">
            P
          </span>

          <span className="nav-brand">
            <strong>
              PulsePoll
            </strong>

            <small>
              Live opinions
            </small>
          </span>
        </button>

        <nav className="nav-links">

          {token && (
            <>
              <button
                className={
                  page === "dashboard"
                    ? "nav-active"
                    : ""
                }
                onClick={() => {
                  setPage("dashboard");
                  loadPolls(token);
                }}
              >
                Polls
              </button>

              <button
                className={
                  page === "create"
                    ? "nav-active"
                    : ""
                }
                onClick={() =>
                  setPage("create")
                }
              >
                Create Poll
              </button>
            </>
          )}

          <span
            className={
              realtimeConnected
                ? "realtime-status connected"
                : "realtime-status"
            }
          >
            <span className="live-dot" />

            {realtimeConnected
              ? "Live"
              : "Offline"}
          </span>

        </nav>

        {token ? (
          <div className="profile-wrap">

            <button
              className="profile-trigger"
              onClick={() =>
                setProfileOpen(
                  (open) => !open
                )
              }
              aria-expanded={
                profileOpen
              }
            >
              <span className="avatar">
                {initial}
              </span>

              <span className="profile-copy">
                <strong>
                  {displayName}
                </strong>

                <small>
                  Account
                </small>
              </span>

              <span className="chevron">
                ⌄
              </span>
            </button>

            {profileOpen && (
              <div className="profile-menu">

                <div className="profile-menu-head">

                  <span className="avatar large">
                    {initial}
                  </span>

                  <div>
                    <strong>
                      {displayName}
                    </strong>

                    <span>
                      {user?.email ||
                        "Signed in"}
                    </span>
                  </div>

                </div>

                <div className="profile-menu-divider" />

                <button
                  className="profile-logout"
                  onClick={logout}
                >
                  <span>↪</span>
                  Log out
                </button>

              </div>
            )}

          </div>
        ) : (
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button
              type="button"
              className="secondary-button"
              style={{ padding: "6px 12px", fontSize: "13px" }}
              onClick={() => setPage("login")}
            >
              Log in
            </button>
            <button
              type="button"
              className="primary-button"
              style={{ padding: "6px 14px", fontSize: "13px" }}
              onClick={() => setPage("signup")}
            >
              Sign up
            </button>
          </div>
        )}

      </header>
    );
  }

  // --------------------------------------------------
  // DASHBOARD
  // --------------------------------------------------

  function renderDashboard() {
    const normalizedSearch =
      searchTerm.trim().toLowerCase();

    const filteredPolls =
      polls
        .filter((poll) => {
          const matchesSearch =
            !normalizedSearch ||
            poll.question
              ?.toLowerCase()
              .includes(
                normalizedSearch
              );

          const matchesStatus =
            statusFilter === "all" ||
            poll.status ===
              statusFilter;

          return (
            matchesSearch &&
            matchesStatus
          );
        })
        .sort((a, b) => {
          if (
            sortBy === "votes"
          ) {
            return (
              totalVotes(b) -
              totalVotes(a)
            );
          }

          return String(
            b.createdAt ||
              b.id ||
              ""
          ).localeCompare(
            String(
              a.createdAt ||
                a.id ||
                ""
            )
          );
        });

    const activeCount =
      polls.filter(
        (poll) =>
          poll.status === "active"
      ).length;

    const closedCount =
      polls.filter(
        (poll) =>
          poll.status === "closed"
      ).length;

    const voteCount =
      polls.reduce(
        (sum, poll) =>
          sum + totalVotes(poll),
        0
      );

    return (
      <div className="app-shell">

        {renderNavbar()}

        <main className="main-container dashboard-container">

          <section className="hero professional-hero">

            <div className="hero-copy">

              <div className="eyebrow-row">

                <span className="eyebrow">
                  POLLING WORKSPACE
                </span>

                <span className="live-badge">
                  <span className="live-dot" />
                  REAL-TIME
                </span>

              </div>

              <h1>
                Turn questions into{" "}
                <span>
                  live decisions.
                </span>
              </h1>

              <p>
                Create a poll, collect responses and watch the results move in real time.
              </p>

            </div>

            <button
              className="primary-button hero-button"
              onClick={() =>
                setPage("create")
              }
            >
              <span>＋</span>
              Create Poll
            </button>

          </section>

          <section
            className="stats-grid"
            aria-label="Polling overview"
          >

            <div className="stat-card">
              <span className="stat-icon">
                ◉
              </span>

              <div>
                <strong>
                  {polls.length}
                </strong>

                <span>
                  Total polls
                </span>
              </div>
            </div>

            <div className="stat-card">
              <span className="stat-icon">
                ●
              </span>

              <div>
                <strong>
                  {activeCount}
                </strong>

                <span>
                  Active now
                </span>
              </div>
            </div>

            <div className="stat-card">
              <span className="stat-icon">
                ✓
              </span>

              <div>
                <strong>
                  {voteCount}
                </strong>

                <span>
                  Total votes
                </span>
              </div>
            </div>

            <div className="stat-card">
              <span className="stat-icon">
                ○
              </span>

              <div>
                <strong>
                  {closedCount}
                </strong>

                <span>
                  Closed polls
                </span>
              </div>
            </div>

          </section>

          <section className="poll-section">

            <div className="section-heading dashboard-heading">

              <div>
                <p className="eyebrow">
                  YOUR POLLS
                </p>

                <h2>
                  All polls
                </h2>

                <p>
                  Search, filter and manage your polling workspace.
                </p>
              </div>

              <button
                className="refresh-button"
                onClick={() =>
                  loadPolls(token)
                }
              >
                ↻ Refresh
              </button>

            </div>

            <div className="toolbar">

              <div className="search-box">

                <span>⌕</span>

                <input
                  value={searchTerm}
                  onChange={(e) =>
                    setSearchTerm(
                      e.target.value
                    )
                  }
                  placeholder="Search polls..."
                />

                {searchTerm && (
                  <button
                    onClick={() =>
                      setSearchTerm("")
                    }
                    aria-label="Clear search"
                  >
                    ×
                  </button>
                )}

              </div>

              <div className="filter-group">

                {[
                  ["all", "All"],
                  ["active", "Active"],
                  ["closed", "Closed"],
                ].map(
                  ([value, label]) => (
                    <button
                      key={value}
                      className={
                        statusFilter ===
                        value
                          ? "filter-active"
                          : ""
                      }
                      onClick={() =>
                        setStatusFilter(
                          value
                        )
                      }
                    >
                      {label}
                    </button>
                  )
                )}

              </div>

              <select
                className="sort-select"
                value={sortBy}
                onChange={(e) =>
                  setSortBy(
                    e.target.value
                  )
                }
              >
                <option value="newest">
                  Newest
                </option>

                <option value="votes">
                  Most votes
                </option>
              </select>

            </div>

            {polls.length === 0 ? (
              <div className="empty-state polished-empty">

                <div className="empty-icon">
                  ◉
                </div>

                <h3>
                  No polls yet
                </h3>

                <p>
                  Create your first poll and start collecting opinions.
                </p>

                <button
                  className="primary-button"
                  onClick={() =>
                    setPage("create")
                  }
                >
                  Create your first poll
                </button>

              </div>
            ) : filteredPolls.length === 0 ? (
              <div className="empty-state polished-empty compact-empty">

                <div className="empty-icon">
                  ⌕
                </div>

                <h3>
                  No matching polls
                </h3>

                <p>
                  Try another search term or change the filter.
                </p>

                <button
                  className="secondary-button"
                  onClick={() => {
                    setSearchTerm("");
                    setStatusFilter(
                      "all"
                    );
                  }}
                >
                  Clear filters
                </button>

              </div>
            ) : (
              <div className="poll-grid">

                {filteredPolls.map(
                  (poll) => {
                    const total =
                      totalVotes(poll);

                    const leading =
                      poll.options?.length && Array.isArray(poll.votes) && poll.votes.length > 0
                        ? Math.max(...poll.votes)
                        : 0;

                    const leadingIndex =
                      poll.votes?.findIndex(
                        (v) =>
                          v ===
                          leading
                      ) ?? -1;

                    return (
                      <article
                        className="poll-card"
                        key={poll.id}
                      >

                        <div className="poll-card-top">

                          <span
                            className={
                              poll.status ===
                              "active"
                                ? "status active"
                                : "status closed"
                            }
                          >
                            {poll.status}
                          </span>

                          {isCreator(
                            poll
                          ) && (
                            <span className="creator-tag">
                              Created by you
                            </span>
                          )}

                        </div>

                        <h3>
                          {poll.question}
                        </h3>

                        <div className="card-meta">

                          <span>
                            {total}{" "}
                            {total === 1
                              ? "vote"
                              : "votes"}
                          </span>

                          <span>
                            {poll.options
                              ?.length ||
                              0}{" "}
                            options
                          </span>

                        </div>

                        <div className="mini-options">

                          {poll.options
                            ?.slice(0, 3)
                            .map(
                              (
                                option,
                                index
                              ) => {
                                const votes =
                                  poll
                                    .votes?.[
                                    index
                                  ] ||
                                  0;

                                const percentage =
                                  total
                                    ? Math.round(
                                        (votes /
                                          total) *
                                          100
                                      )
                                    : 0;

                                return (
                                  <div
                                    className="mini-option enhanced-option"
                                    key={
                                      index
                                    }
                                  >

                                    <div className="option-label">

                                      <span>
                                        {
                                          option
                                        }
                                      </span>

                                      <strong>
                                        {
                                          percentage
                                        }
                                        %
                                      </strong>

                                    </div>

                                    <div className="mini-progress">

                                      <span
                                        style={{
                                          width:
                                            `${percentage}%`,
                                        }}
                                      />

                                    </div>

                                  </div>
                                );
                              }
                            )}

                          {poll.options
                            ?.length >
                            3 && (
                            <small>
                              ＋
                              {poll
                                .options
                                .length -
                                3}{" "}
                              more options
                            </small>
                          )}

                        </div>

                        {leadingIndex >=
                          0 &&
                          total > 0 && (
                            <div className="leading-note">
                              Leading:{" "}
                              <strong>
                                {
                                  poll
                                    .options[
                                    leadingIndex
                                  ]
                                }
                              </strong>
                            </div>
                          )}

                        <div className="card-actions-row">

                          <button
                            className="secondary-button main-action"
                            onClick={() =>
                              openPoll(
                                poll.id
                              )
                            }
                          >
                            View results
                          </button>

                          <button
                            className={
                              copiedLink === poll.id
                                ? "card-share-btn copied"
                                : "card-share-btn"
                            }
                            onClick={(e) =>
                              copyPollLink(
                                poll.id,
                                e
                              )
                            }
                            title="Copy link to clipboard"
                          >
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              {copiedLink === poll.id ? (
                                <polyline points="20 6 9 17 4 12" />
                              ) : (
                                <>
                                  <rect
                                    x="9"
                                    y="9"
                                    width="13"
                                    height="13"
                                    rx="2"
                                    ry="2"
                                  />
                                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                </>
                              )}
                            </svg>
                            <span>
                              {copiedLink === poll.id
                                ? "Copied! ✓"
                                : "Copy Link"}
                            </span>
                          </button>

                          <button
                            className="icon-btn-compact"
                            onClick={(e) => {
                              e.stopPropagation();
                              setShareModalPoll(poll);
                            }}
                            title="QR Code & Audience Sharing"
                            aria-label="Share QR code"
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <rect x="3" y="3" width="7" height="7" />
                              <rect x="14" y="3" width="7" height="7" />
                              <rect x="14" y="14" width="7" height="7" />
                              <rect x="3" y="14" width="7" height="7" />
                            </svg>
                          </button>

                          {poll.status ===
                            "active" &&
                            isCreator(
                              poll
                            ) && (
                              <button
                                className="danger-button"
                                style={{ padding: "8px 12px" }}
                                onClick={() =>
                                  closePoll(
                                    poll.id
                                  )
                                }
                                disabled={
                                  loading
                                }
                              >
                                Close
                              </button>
                            )}

                        </div>

                      </article>
                    );
                  }
                )}

              </div>
            )}

          </section>

        </main>

      </div>
    );
  }

  // --------------------------------------------------
  // CREATE POLL PAGE
  // --------------------------------------------------

  function renderCreatePoll() {
    return (
      <div className="app-shell">

        {renderNavbar()}

        <main className="main-container create-layout">

          <div className="page-heading create-heading">

            <div>
              <p className="eyebrow">
                NEW POLL
              </p>

              <h1>
                Create a poll
              </h1>

              <p>
                Keep the question clear and give people simple choices.
              </p>
            </div>

            <span className="step-indicator">
              <span className="step-active">
                1
              </span>{" "}
              Setup
              <i />
              <span>2</span>{" "}
              Publish
            </span>

          </div>

          <div className="create-workspace">

            <form
              className="create-card"
              onSubmit={createPoll}
            >

              <div className="form-section-title">

                <span className="section-number">
                  01
                </span>

                <div>
                  <strong>
                    Question
                  </strong>

                  <p>
                    What do you want to ask?
                  </p>
                </div>

              </div>

              <input
                className="question-input"
                type="text"
                placeholder="e.g. Which technology should we learn next?"
                value={
                  pollForm.question
                }
                onChange={(e) =>
                  setPollForm({
                    ...pollForm,
                    question:
                      e.target.value,
                  })
                }
                required
              />

              <div className="form-section-title options-title">

                <span className="section-number">
                  02
                </span>

                <div>
                  <strong>
                    Answer options
                  </strong>

                  <p>
                    Give voters at least two choices.
                  </p>
                </div>

                <span className="option-counter">
                  {
                    pollForm.options
                      .length
                  }
                  /10
                </span>

              </div>

              {/* Image URL toggle */}
              <div className="img-toggle-row">
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={showImages}
                    onChange={(e) => setShowImages(e.target.checked)}
                  />
                  <span className="slider" />
                </label>
                <label htmlFor="img-toggle" style={{ marginTop: 0 }}>
                  Add images to options
                </label>
                <span className="img-toggle-hint">Optional — paste any public image URL</span>
              </div>

              <div className="option-list">

                {pollForm.options.map(
                  (option, index) => (
                    <div
                      className="option-input-row"
                      key={index}
                    >
                      <span className="option-number">
                        {String(index + 1).padStart(2, "0")}
                      </span>

                      <div className="option-input-col">
                        <input
                          type="text"
                          placeholder={`Option ${index + 1}`}
                          value={option}
                          onChange={(e) => updateOption(index, e.target.value)}
                          required
                        />

                        {showImages && (
                          <div className="option-img-row">
                            <input
                              type="url"
                              className="option-img-input"
                              placeholder="Image URL (optional)"
                              value={(pollForm.imageUrls || [])[index] || ""}
                              onChange={(e) => updateImageUrl(index, e.target.value)}
                            />
                            {(pollForm.imageUrls || [])[index]?.trim() && (
                              <img
                                src={(pollForm.imageUrls || [])[index]}
                                alt="preview"
                                className="option-thumb"
                                onError={(e) => { e.target.style.display = "none"; }}
                                onLoad={(e) => { e.target.style.display = "block"; }}
                              />
                            )}
                          </div>
                        )}
                      </div>

                      {pollForm.options.length > 2 && (
                        <button
                          type="button"
                          className="remove-button"
                          onClick={() => removeOption(index)}
                          aria-label={`Remove option ${index + 1}`}
                        >
                          ×
                        </button>
                      )}

                    </div>
                  )
                )}

              </div>

              <button
                type="button"
                className="add-option-button"
                onClick={
                  addOption
                }
                disabled={
                  pollForm.options
                    .length >= 10
                }
              >
                ＋ Add another option
              </button>

              <div className="form-actions">

                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    setPage(
                      "dashboard"
                    )
                  }
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="primary-button"
                  disabled={loading}
                >
                  {loading
                    ? "Publishing..."
                    : "Publish Poll"}
                </button>

              </div>

            </form>

            <aside className="poll-preview">

              <div className="preview-label">
                <span>
                  LIVE PREVIEW
                </span>

                <span>
                  Audience view
                </span>
              </div>

              <div className="preview-card">

                <div className="preview-status">

                  <span className="status active">
                    active
                  </span>

                  <span>
                    0 votes
                  </span>

                </div>

                <h2>
                  {pollForm.question.trim() ||
                    "Your poll question will appear here"}
                </h2>

                <p className="preview-helper">
                  Select one option to vote.
                </p>

                <div className="preview-options">

                  {pollForm.options.map(
                    (option, index) => (
                      <div
                        className="preview-option"
                        key={index}
                      >
                        <span className="radio" />

                        {option.trim() ||
                          `Option ${
                            index + 1
                          }`}
                      </div>
                    )
                  )}

                </div>

                <button
                  className="primary-button full"
                  type="button"
                  disabled
                >
                  Submit Vote
                </button>

              </div>

              <p className="preview-note">
                Your poll will use the same live results experience after publishing.
              </p>

            </aside>

          </div>

        </main>

      </div>
    );
  }

  // --------------------------------------------------
  // POLL DETAILS
  // --------------------------------------------------

  function renderPoll() {
    if (!selectedPoll) {
      return (
        <div className="app-shell">
          {renderNavbar()}
          <main className="main-container narrow poll-page">
            <button
              className="back-button"
              onClick={() => {
                if (token) {
                  setPage("dashboard");
                  loadPolls(token);
                } else {
                  setPage("login");
                }
              }}
            >
              ← {token ? "Back to polls" : "PulsePoll Home"}
            </button>
            <div className="empty-state polished-empty" style={{ marginTop: "24px" }}>
              <div className="empty-icon">◉</div>
              <h3>Poll not found</h3>
              <p>The poll you are looking for does not exist or could not be loaded.</p>
              <button
                className="primary-button"
                onClick={() => {
                  if (token) {
                    setPage("dashboard");
                    loadPolls(token);
                  } else {
                    setPage("login");
                  }
                }}
              >
                {token ? "Return to Dashboard" : "Go to Sign In"}
              </button>
            </div>
          </main>
        </div>
      );
    }

    const total =
      totalVotes(selectedPoll);

    const voteValues =
      selectedPoll.votes || [];

    const leadingVotes =
      selectedPoll.options?.length && voteValues.length > 0
        ? Math.max(
            ...voteValues
          )
        : 0;

    const leadingIndex =
      voteValues.findIndex(
        (value) =>
          value ===
          leadingVotes
      );

    return (
      <div className="app-shell">

        {renderNavbar()}

        <main className="main-container narrow poll-page">

          <button
            className="back-button"
            onClick={() => {
              if (token) {
                setPage("dashboard");
                loadPolls(token);
              } else {
                setPage("login");
              }
            }}
          >
            ← {token ? "Back to polls" : "PulsePoll Home"}
          </button>

          {!token && (
            <div className="guest-hero-banner">
              <span>👋 <strong>Audience Live Voting:</strong> You can vote directly. Results update live!</span>
              <button
                type="button"
                className="secondary-button"
                style={{ padding: "4px 12px", fontSize: "12px" }}
                onClick={() => setPage("signup")}
              >
                Create your own poll →
              </button>
            </div>
          )}

          <div className="poll-detail-card professional-detail">

            <div className="poll-detail-header">

              <div className="detail-status-row">

                <span
                  className={
                    selectedPoll.status ===
                    "active"
                      ? "status active"
                      : "status closed"
                  }
                >
                  {
                    selectedPoll.status
                  }
                </span>

                {realtimeConnected && (
                  <span className="live-badge">
                    <span className="live-dot" />
                    Updating live
                  </span>
                )}

              </div>

              <span>
                {total}{" "}
                {total === 1
                  ? "vote"
                  : "votes"}
              </span>

            </div>

            <h1>
              {
                selectedPoll.question
              }
            </h1>

            <div className="poll-share-bar">
              <button
                type="button"
                className={
                  copiedLink === selectedPoll.id
                    ? "share-action-btn copied"
                    : "share-action-btn"
                }
                onClick={() => copyPollLink(selectedPoll.id)}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {copiedLink === selectedPoll.id ? (
                    <polyline points="20 6 9 17 4 12" />
                  ) : (
                    <>
                      <rect
                        x="9"
                        y="9"
                        width="13"
                        height="13"
                        rx="2"
                        ry="2"
                      />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </>
                  )}
                </svg>
                <span>
                  {copiedLink === selectedPoll.id
                    ? "Link Copied! ✓"
                    : "Copy Share Link"}
                </span>
              </button>

              <button
                type="button"
                className="share-action-btn secondary"
                onClick={() => setShareModalPoll(selectedPoll)}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <rect x="3" y="3" width="7" height="7" />
                  <rect x="14" y="3" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" />
                  <rect x="3" y="14" width="7" height="7" />
                </svg>
                <span>QR Code & Audience</span>
              </button>
            </div>

            {selectedPoll.hasVoted && (
              <div className="voted-badge-box">
                <div className="voted-badge-icon">✓</div>
                <div className="voted-badge-text">
                  <h4>Your vote is recorded!</h4>
                  <p>
                    You have already voted on this poll. Live results are updating below in real time.
                  </p>
                </div>
              </div>
            )}

            <div className="detail-divider" />

            {selectedPoll.status ===
            "active" ? (
              <>
                <p className="poll-instruction">
                  Select one option and submit your vote.
                </p>

                <div className="vote-options">

                  {selectedPoll.options?.map(
                    (option, index) => (
                      <button
                        key={index}
                        type="button"
                        className={
                          selectedOption === index
                            ? "vote-option selected"
                            : "vote-option"
                        }
                        onClick={() => setSelectedOption(index)}
                      >
                        <span className="radio">
                          {selectedOption === index ? "✓" : ""}
                        </span>

                        {selectedPoll.imageUrls?.[index]?.trim() && (
                          <img
                            src={selectedPoll.imageUrls[index]}
                            alt={option}
                            className="vote-option-img"
                            onError={(e) => { e.target.style.display = "none"; }}
                          />
                        )}

                        <span>{option}</span>
                      </button>
                    )
                  )}

                </div>

                {selectedPoll.hasVoted ? (
                  <button
                    className="secondary-button full"
                    disabled
                    style={{ opacity: 0.85, cursor: "default" }}
                  >
                    ✓ Your Vote is Recorded
                  </button>
                ) : (
                  <button
                    className="primary-button full vote-submit"
                    onClick={
                      votePoll
                    }
                    disabled={
                      loading ||
                      selectedOption ===
                        null
                    }
                  >
                    {loading
                      ? "Submitting..."
                      : "Submit Vote"}
                  </button>
                )}

              </>
            ) : (
              <div className="closed-message">

                <div className="closed-icon">
                  ✓
                </div>

                <div>
                  <h3>
                    This poll is closed
                  </h3>

                  <p>
                    Voting is no longer available. You can still review the final results below.
                  </p>
                </div>

              </div>
            )}

            <div className="results professional-results">

              <div className="results-header">

                <div>
                  <p className="eyebrow">
                    LIVE RESULTS
                  </p>

                  <h2>
                    Response breakdown
                  </h2>
                </div>

                <span>
                  {total} total
                </span>

              </div>

              {leadingIndex >= 0 &&
                total > 0 && (
                  <div className="winner-callout">
                    Leading option{" "}
                    <strong>
                      {
                        selectedPoll
                          .options[
                          leadingIndex
                        ]
                      }
                    </strong>{" "}
                    with{" "}
                    {leadingVotes}{" "}
                    {leadingVotes ===
                    1
                      ? "vote"
                      : "votes"}
                  </div>
                )}

              {selectedPoll.options?.map(
                (
                  option,
                  index
                ) => {
                  const percentage =
                    getPercentage(
                      selectedPoll,
                      index
                    );

                  const votes =
                    selectedPoll
                      .votes?.[
                      index
                    ] || 0;

                  const isLeading = index === leadingIndex && total > 0;

                  return (
                    <div className="result-row" key={index}>

                      <div className="result-label">
                        <span>
                          {selectedPoll.imageUrls?.[index]?.trim() && (
                            <img
                              src={selectedPoll.imageUrls[index]}
                              alt={option}
                              className="result-thumb"
                              onError={(e) => { e.target.style.display = "none"; }}
                            />
                          )}
                          {option}
                          {isLeading && (
                            <span className="leading-badge">Leading</span>
                          )}
                        </span>
                        <span>{votes} · {percentage}%</span>
                      </div>

                      <div className="progress-bar">
                        <div
                          className={`progress-fill${isLeading ? " leading" : ""}`}
                          style={{ width: `${percentage}%` }}
                        />
                      </div>

                    </div>
                  );
                }
              )}

            </div>

            {selectedPoll.status ===
              "active" &&
              isCreator(
                selectedPoll
              ) && (
                <button
                  className="danger-button full"
                  onClick={() =>
                    closePoll(
                      selectedPoll.id
                    )
                  }
                  disabled={loading}
                >
                  Close poll
                </button>
              )}

          </div>

        </main>

      </div>
    );
  }

  // --------------------------------------------------
  // MAIN APP
  // --------------------------------------------------

  function renderApp() {
    if (page === "poll") {
      return renderPoll();
    }

    if (!token) {
      if (page === "signup") {
        return renderSignup();
      }

      return renderLogin();
    }

    if (page === "create") {
      return renderCreatePoll();
    }

    return renderDashboard();
  }

  // --------------------------------------------------
  // GOOGLE ACCOUNT CHOOSER MODAL
  // --------------------------------------------------

  function renderGoogleModal() {
    if (!showGoogleModal) return null;

    return (
      <div className="google-modal-overlay" onClick={() => setShowGoogleModal(false)}>
        <div className="google-modal-card" onClick={(e) => e.stopPropagation()}>
          <div className="google-modal-header">
            <svg className="google-icon" viewBox="0 0 24 24" width="24" height="24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
            </svg>
            <div>
              <h3>Choose an account</h3>
              <span style={{ fontSize: "12px", color: "#6b7280" }}>to continue to PulsePoll</span>
            </div>
          </div>

          <p className="google-modal-subtitle">
            Enter your Google email address to sign in to PulsePoll.
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (customGoogleEmail.trim()) {
                handleGoogleLogin({
                  email: customGoogleEmail.trim(),
                  name: customGoogleEmail.split("@")[0],
                });
              }
            }}
            style={{ marginBottom: "16px" }}
          >
            <label style={{ fontSize: "13px", fontWeight: 600, color: "#374151", display: "block", marginBottom: "6px" }}>
              Google Email Address
            </label>
            <input
              type="email"
              placeholder="name@gmail.com"
              value={customGoogleEmail}
              onChange={(e) => setCustomGoogleEmail(e.target.value)}
              required
              autoFocus
              style={{
                width: "100%",
                padding: "11px 14px",
                borderRadius: "10px",
                border: "1px solid #d1d5db",
                fontSize: "14px",
                background: "#f9fafb",
                color: "#111827",
                marginBottom: "14px",
                boxSizing: "border-box"
              }}
            />
            <button
              type="submit"
              className="primary-button full"
              disabled={!customGoogleEmail.trim() || loading}
            >
              {loading ? "Signing in..." : "Continue with Google"}
            </button>
          </form>

          <button
            type="button"
            className="google-modal-cancel"
            onClick={() => setShowGoogleModal(false)}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // --------------------------------------------------
  // MAIN RETURN
  // --------------------------------------------------

  return (
    <>
      {error && (
        <div className="toast error-toast">
          {error}
        </div>
      )}

      {success && (
        <div className="toast success-toast">
          {success}
        </div>
      )}

      {renderApp()}
      {renderShareModal()}
      {renderGoogleModal()}
    </>
  );
}

export default App;