// A large page for page-side DOM cost: a long table, a big labelled form, open
// shadow roots nested three deep, a 1200-option listbox, a 400-option select and
// a wide role=button region. Deterministic, so goldens can pin its outputs.
// build(document) fills a live document; html() is the same page as a file to
// serve over http for a live check (the shadow roots need its script to run).

export function build(document) {
  const CITY = ["Córdoba", "Rosario", "Mendoza", "São Paulo", "Montréal", "Zürich", "Bogotá", "Kraków", "Málaga", "Toronto",
    "Santa Fe", "San José", "Québec", "Genève", "Reykjavík", "Łódź", "Curitiba", "Medellín", "Asunción", "Göteborg"];
  const REGION = ["Argentina", "Brazil", "Canada", "Spain", "Poland", "Switzerland", "Colombia", "Paraguay", "Sweden", "Iceland"];
  const WORD = ["alpha", "bravo", "cargo", "delta", "echo", "fleet", "grove", "harbor", "index", "jolt", "kilo", "lumen"];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const words = (k) => Array.from({ length: k }, () => WORD[rnd(WORD.length)]).join(" ");
  const h = [];

  h.push(`<header><h1>Operations console</h1><nav>`);
  for (let i = 0; i < 40; i++) h.push(`<a href="/section/${i}">Section ${i} ${words(1)}</a>`);
  h.push(`</nav></header>`);

  // Long table: every row has a checkbox, a link, a button and plain cells.
  h.push(`<main><h2>Shipments</h2><table><thead><tr><th>Pick</th><th>Id</th><th>Route</th><th>Note</th><th>Act</th></tr></thead><tbody>`);
  for (let r = 0; r < 400; r++) {
    h.push(`<tr><td><label><input type=checkbox name=row${r}> Row ${r}</label></td><td><a href="/ship/${r}">SH-${1000 + r}</a></td>` +
      `<td>${CITY[r % CITY.length]}, ${REGION[r % REGION.length]}</td><td><span>${words(3)}</span> <em>${words(2)}</em></td>` +
      `<td><button type=button${r % 7 === 0 ? " disabled" : ""}>Open ${r}</button></td></tr>`);
  }
  h.push(`</tbody></table>`);

  // A big form: explicit labels, wrapping labels, aria-labelledby, placeholders,
  // unlabelled fields named by nearby text, fieldsets and required fields.
  h.push(`<form id=big><h2>Customer details</h2>`);
  for (let i = 0; i < 60; i++) {
    const k = i % 6;
    h.push(`<fieldset><legend>Group ${i}</legend><div class=row>`);
    if (k === 0) h.push(`<label for=f${i}>Full name ${i}</label><input id=f${i} name=name${i}${i % 4 === 0 ? " required" : ""}>`);
    if (k === 1) h.push(`<label>Email ${i} <input type=email name=email${i}></label>`);
    if (k === 2) h.push(`<span id=lb${i}>Shipping city ${i}</span><input aria-labelledby=lb${i} name=city${i}>`);
    if (k === 3) h.push(`<div><p>What is your phone ${i}?<span>*</span></p></div><div><input type=tel name=phone${i}></div>`);
    if (k === 4) h.push(`<input placeholder="Search orders ${i}" name=q${i}>`);
    if (k === 5) h.push(`<label for=t${i}>Notes ${i}</label><textarea id=t${i} name=notes${i}>${words(4)}</textarea>`);
    h.push(`<div class=help>${words(6)}</div></div></fieldset>`);
  }
  h.push(`<label>Country <select name=country><option value="">Pick one</option>`);
  for (let i = 0; i < 400; i++) h.push(`<option value=c${i}>${CITY[i % CITY.length]} ${REGION[(i >> 2) % REGION.length]} ${i}</option>`);
  h.push(`</select></label>`);
  h.push(`<label><input type=radio name=plan value=m> Monthly</label><label><input type=radio name=plan value=y> Yearly</label>`);
  h.push(`<button type=submit>Save details</button></form>`);

  // A big listbox owned by a combobox, city options with comma parts.
  h.push(`<div class=picker><label for=dest>Destination</label><input id=dest role=combobox aria-controls=dest-list aria-expanded=true aria-autocomplete=list>`);
  h.push(`</div><ul id=dest-list role=listbox>`);
  for (let i = 0; i < 1200; i++) {
    h.push(`<li role=option id=o${i}>${CITY[i % CITY.length]}, ${REGION[Math.floor(i / CITY.length) % REGION.length]}${i >= 200 ? ", Zone " + i : ""}</li>`);
  }
  h.push(`</ul>`);

  // A clickable region whose name comes from a lot of content.
  h.push(`<div role=button tabindex=0 id=wide><strong>Expand all</strong> ${Array.from({ length: 300 }, (_, i) => `<span>${words(2)} ${i}</span>`).join("")}</div>`);
  h.push(`<div id=hosts></div><footer><p>${words(20)}</p></footer></main>`);
  document.body.innerHTML = h.join("");

  // Open shadow roots, three deep, with labelled fields and buttons at each level.
  const hosts = document.getElementById("hosts");
  for (let i = 0; i < 30; i++) {
    const a = document.createElement("x-card");
    hosts.appendChild(a);
    const sa = a.attachShadow({ mode: "open" });
    sa.innerHTML = `<h3>Card ${i}</h3><label for=s${i}>Shadow field ${i}</label><input id=s${i} name=shadow${i}>` +
      `<p>${words(5)}</p><x-inner></x-inner><button>Card action ${i}</button>`;
    const sb = sa.querySelector("x-inner").attachShadow({ mode: "open" });
    sb.innerHTML = `<span id=in${i}>Inner code ${i}</span><input aria-labelledby=in${i}><x-deep></x-deep><a href="/inner/${i}">Inner link ${i}</a>`;
    sb.querySelector("x-deep").attachShadow({ mode: "open" }).innerHTML =
      `<div role=checkbox aria-checked=${i % 2 ? "true" : "false"} tabindex=0>Deep toggle ${i}</div><input placeholder="Deep search ${i}">`;
  }
}

export function html() {
  return `<!doctype html><html><head><meta charset=utf-8><title>perch large DOM</title></head><body>` +
    `<script>(${build.toString()})(document)</script></body></html>`;
}
