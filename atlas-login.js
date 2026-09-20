(function (global) {
  "use strict";
  // Shared by browser authentication, account administration and the SQL proposal generator.
  const rules = Object.freeze({ visibleMaximum: 60, keyMaximum: 48,
    whitespace: "[\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+",
    marks: "[\\u0300-\\u036f]", allowed: "^[A-Za-z0-9 ._-]+$", keyAllowed: "^[a-z0-9._-]{2,48}$" });
  const invalid = () => { const error = new Error("Enter a valid sign-in name (2–60 characters); email addresses are not allowed."); error.code = "LOGIN_NAME_INVALID"; throw error; };
  const identity = (value) => {
    if (typeof value !== "string") return invalid();
    const name = value.normalize("NFKC").replace(new RegExp(rules.whitespace, "g"), " ").trim();
    if (name.length < 2 || name.length > rules.visibleMaximum || name.includes("@")) return invalid();
    const folded = name.normalize("NFKD").replace(new RegExp(rules.marks, "g"), "");
    if (!new RegExp(rules.allowed).test(folded)) return invalid();
    // Removing separators preserves existing employee credential keys.
    const key = folded.toLowerCase().replace(/ /g, "");
    if (!new RegExp(rules.keyAllowed).test(key)) return invalid();
    return { name, key };
  };
  const receiverName = code => code === "CA" || code === "TX" ? `${code} COC Receiver` : "";
  global.AtlasLogin = Object.freeze({ rules, identity, receiverName });
})(typeof window === "undefined" ? globalThis : window);
