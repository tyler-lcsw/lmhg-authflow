window.AUTH_FORMS_API_BASE = window.location.pathname.startsWith("/api/legacy/auth-manager")
  ? "/api/legacy/auth-manager/api"
  : "/api";
window.AUTH_FORMS_PROXY_AUTH = window.location.pathname.startsWith("/api/legacy/auth-manager");
