const authFormsLegacyPath = window.location.pathname.startsWith("/api/legacy/auth-manager");
const authFormsLocalhost = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);

window.AUTH_FORMS_API_BASE = authFormsLegacyPath
  ? "/api/legacy/auth-manager/api"
  : "/api";
window.AUTH_FORMS_PROXY_AUTH = authFormsLegacyPath || authFormsLocalhost;
