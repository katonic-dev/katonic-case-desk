// Who is using the desk.
//
// On the platform, App Studio puts a sign-in step in front of the app and that
// step sets X-Forwarded-Email, X-Forwarded-User, X-Forwarded-Groups and
// X-Forwarded-Preferred-Username on every request, stripping any copy the
// browser sent. The desk believes those headers ONLY when
// TRUST_SIGN_IN_HEADERS=true, which is safe only where nothing can reach the
// app except through that step (a packaged app with headerTrust in its
// definition; see platform/README.md). Anywhere
// else the desk uses the stand-in identity from LOCAL_USER and says so in the
// register ("identity_source": "stand-in").

function readIdentity(headers, env = process.env) {
  const trusted = String(env.TRUST_SIGN_IN_HEADERS || "").toLowerCase() === "true";
  const h = (name) => {
    const v = headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v || "";
  };
  if (trusted && h("x-forwarded-email")) {
    return {
      email: h("x-forwarded-email"),
      name: h("x-forwarded-preferred-username") || h("x-forwarded-email"),
      subject: h("x-forwarded-user") || "",
      groups: h("x-forwarded-groups") ? h("x-forwarded-groups").split(",").map((s) => s.trim()).filter(Boolean) : [],
      source: "platform-sign-in",
    };
  }
  return {
    email: env.LOCAL_USER || "officer@example.invalid",
    name: env.LOCAL_USER_NAME || "Local officer",
    subject: "",
    groups: [],
    source: "stand-in",
  };
}

module.exports = { readIdentity };
