(function () {
  "use strict";

  // Locate this script tag to extract the ?id= parameter
  var scripts = document.querySelectorAll('script[src*="badge.js"]');
  var scriptEl = scripts[scripts.length - 1];
  if (!scriptEl) return;

  var src = scriptEl.getAttribute("src") || "";
  var qIdx = src.indexOf("?");
  var params = new URLSearchParams(qIdx >= 0 ? src.slice(qIdx + 1) : "");
  var userId = params.get("id");
  if (!userId) return;

  // Inject host element (fixed bottom-right)
  var host = document.createElement("div");
  host.setAttribute("id", "vouch-badge-host");
  host.style.cssText =
    "position:fixed;bottom:20px;right:20px;z-index:2147483647;font-size:0;line-height:0;";

  // Use Shadow DOM so host styles can't bleed in or out
  var shadow = host.attachShadow({ mode: "open" });

  var style = document.createElement("style");
  style.textContent = [
    "*{box-sizing:border-box;margin:0;padding:0;}",
    "@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}",
    "@keyframes badgePulse{0%,100%{box-shadow:0 8px 32px rgba(0,0,0,.45),0 0 0 0 rgba(200,169,110,.25)}60%{box-shadow:0 8px 32px rgba(0,0,0,.45),0 0 16px 6px rgba(200,169,110,.12)}}",
    ".badge{",
    "  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;",
    "  background:#0e0e0e;border:1px solid #2a2a2a;border-radius:14px;",
    "  padding:14px 18px;min-width:176px;cursor:pointer;",
    "  opacity:0;transform:translateY(8px);",
    "  transition:opacity .45s ease,transform .45s ease,box-shadow .2s ease;",
    "  animation:badgePulse 3s 1.6s infinite;",
    "}",
    ".badge.visible{opacity:1;transform:translateY(0);}",
    ".badge:hover{transform:translateY(-2px)!important;box-shadow:0 14px 40px rgba(0,0,0,.55)!important;animation:none!important;}",
    ".logo{font-size:.65rem;font-weight:700;color:#c8a96e;letter-spacing:.07em;",
    "  text-transform:uppercase;font-style:italic;margin-bottom:10px;}",
    ".score-row{display:flex;align-items:baseline;gap:5px;margin-bottom:3px;}",
    ".score-num{font-size:2rem;font-weight:700;color:#c8a96e;line-height:1;}",
    ".score-star{font-size:1.1rem;}",
    ".count{font-size:.71rem;color:#555;margin-bottom:9px;}",
    ".verified{display:flex;align-items:center;gap:5px;font-size:.71rem;font-weight:600;color:#4caf7d;}",
    ".verified-dot{width:6px;height:6px;border-radius:50%;background:#4caf7d;flex-shrink:0;}",
    ".shimmer{background:linear-gradient(90deg,#1a1a1a 25%,#2a2a2a 50%,#1a1a1a 75%);",
    "  background-size:200% 100%;animation:shimmer 1.4s infinite;border-radius:4px;}",
  ].join("");
  shadow.appendChild(style);

  var badge = document.createElement("div");
  badge.className = "badge";
  badge.innerHTML =
    '<div class="logo">✦ Vouch</div>' +
    '<div style="display:flex;flex-direction:column;gap:8px;padding:2px 0">' +
    '  <div class="shimmer" style="height:30px;width:78px;"></div>' +
    '  <div class="shimmer" style="height:11px;width:118px;"></div>' +
    '  <div class="shimmer" style="height:11px;width:88px;"></div>' +
    "</div>";
  shadow.appendChild(badge);

  // Fade in after 1 second
  setTimeout(function () { badge.classList.add("visible"); }, 1000);

  // Firestore REST API — no auth needed for public collections
  var FIREBASE_API_KEY = "AIzaSyCB4cRZeklNwb6ShKVynKiQHHKeUcnk51E";
  var endpoint =
    "https://firestore.googleapis.com/v1/projects/vouch-cdf1c/databases/(default)" +
    "/documents/users/" + userId + "/testimonials?pageSize=100&key=" + FIREBASE_API_KEY;

  function render(avg, count) {
    badge.innerHTML =
      '<div class="logo">✦ Vouch</div>' +
      '<div class="score-row">' +
      '  <span class="score-num">' + avg + '</span>' +
      '  <span class="score-star">⭐</span>' +
      '</div>' +
      '<div class="count">' + count + " verified review" + (count !== 1 ? "s" : "") + "</div>" +
      '<div class="verified"><span class="verified-dot"></span>✓ Vouch Verified</div>';
    badge.onclick = function () {
      window.open("https://vouchbusiness.com/profile/" + userId, "_blank", "noopener,noreferrer");
    };
  }

  function renderFallback() {
    badge.innerHTML =
      '<div class="logo">✦ Vouch</div>' +
      '<div class="verified"><span class="verified-dot"></span>✓ Vouch Verified</div>';
    badge.onclick = function () {
      window.open("https://vouchbusiness.com/profile/" + userId, "_blank", "noopener,noreferrer");
    };
  }

  fetch(endpoint)
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (data) {
      var docs = data.documents || [];
      var approved = docs.filter(function (d) {
        return (d.fields && d.fields.status && d.fields.status.stringValue) === "approved";
      });
      var ratings = approved
        .map(function (d) {
          var f = d.fields || {};
          return parseFloat(
            (f.rating && (f.rating.integerValue || f.rating.doubleValue)) || 0
          );
        })
        .filter(function (r) { return r > 0; });

      var count = approved.length;
      var avg =
        ratings.length > 0
          ? (ratings.reduce(function (a, b) { return a + b; }, 0) / ratings.length).toFixed(1)
          : "5.0";
      render(avg, count || 1);
    })
    .catch(renderFallback);

  // Append to body (wait for DOM ready)
  function mount() { document.body.appendChild(host); }
  if (document.body) {
    mount();
  } else {
    document.addEventListener("DOMContentLoaded", mount);
  }
})();
