// Shared by the poster variants: State Stack logo, curved wires between elements, fit-to-window.
const NS = "http://www.w3.org/2000/svg";

// State Stack mark from assets/labos-banner.svg; the dark variant lifts the top layer for dark backgrounds.
function logoSvg(dark) {
  const top = dark ? "#E6EEF6" : "#102A49", line = dark ? "#06101D" : "#FFFFFF", low = dark ? "#41566E" : "#B8C8D8";
  return `<svg viewBox="-12 -24 288 316" xmlns="${NS}"><path d="M0 84 132 16 264 84 132 152Z" fill="${top}"/>` +
    `<path d="M0 150 132 82 264 150 132 218Z" fill="none" stroke="#11B9D4" stroke-width="16" stroke-linejoin="round"/>` +
    `<path d="M0 214 132 146 264 214 132 282Z" fill="none" stroke="${low}" stroke-width="16" stroke-linejoin="round"/>` +
    `<path d="M132 4V218" stroke="${line}" stroke-width="12" stroke-linecap="round"/>` +
    `<circle cx="132" cy="84" r="23" fill="${line}"/><circle cx="132" cy="84" r="13" fill="#11B9D4"/>` +
    `<circle cx="132" cy="4" r="17" fill="#F59E0B"/></svg>`;
}

function edge(el, side, root) {
  const r = el.getBoundingClientRect(), o = root.getBoundingClientRect();
  const x = r.left - o.left, y = r.top - o.top;
  return {
    l: [x, y + r.height / 2, -1, 0], r: [x + r.width, y + r.height / 2, 1, 0],
    t: [x + r.width / 2, y, 0, -1], b: [x + r.width / 2, y + r.height, 0, 1],
  }[side];
}

function svgEl(parent, tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const key in attrs) node.setAttribute(key, attrs[key]);
  return parent.appendChild(node);
}

// Each link: [fromSelector, toSelector, sides ("rl" = from's right edge to to's left edge), extra class].
// Wires go into the nearest [data-wires] ancestor's svg.wires; end dots into its svg.dots when it has one.
function drawWires(links) {
  for (const [from, to, sides = "rl", cls = ""] of links) {
    const a = document.querySelector(from), b = document.querySelector(to);
    if (!a || !b) { console.warn("wire endpoint missing:", from, to); continue; }
    const root = a.closest("[data-wires]");
    const [x1, y1, dx1, dy1] = edge(a, sides[0], root);
    const [x2, y2, dx2, dy2] = edge(b, sides[1], root);
    const k = Math.max(24, (dx1 ? Math.abs(x2 - x1) : Math.abs(y2 - y1)) * 0.5);
    svgEl(root.querySelector(":scope > svg.wires"), "path", {
      class: "wire " + cls,
      d: `M${x1} ${y1} C${x1 + dx1 * k} ${y1 + dy1 * k} ${x2 + dx2 * k} ${y2 + dy2 * k} ${x2} ${y2}`,
    });
    const dots = root.querySelector(":scope > svg.dots");
    if (dots) for (const [x, y] of [[x1, y1], [x2, y2]]) svgEl(dots, "circle", { class: "dot " + cls, cx: x, cy: y, r: 6 });
  }
}

window.addEventListener("load", () => document.fonts.ready.then(() => {
  document.querySelectorAll("[data-logo]").forEach((el) => { el.innerHTML = logoSvg(el.dataset.logo === "dark"); });
  drawWires(window.LINKS || []);
  // Fit small windows like an image; headless renders (render.ps1) stay at 100%.
  const scale = Math.min(1, innerWidth / 1920, innerHeight / 1080);
  if (scale < 1 && !/Headless/.test(navigator.userAgent)) document.querySelector(".poster").style.zoom = scale;
}));
