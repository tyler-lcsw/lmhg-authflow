const authFormsLegacyPath = window.location.pathname.startsWith("/api/legacy/auth-manager");

window.AUTH_FORMS_API_BASE = authFormsLegacyPath
  ? "/api/legacy/auth-manager/api"
  : "/api";
window.AUTH_FORMS_PROXY_AUTH = authFormsLegacyPath;
