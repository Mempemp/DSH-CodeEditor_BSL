// lib/metadata.js — 1C configuration metadata tree, 3 dump formats.
//
//   • edt      — EDT project: <root>/Configuration/Configuration.mdo, objects in
//                src-style dirs (Catalogs/<Name>/<Name>.mdo, ...).
//   • xml      — Designer "dump to files" WITH ConfigDumpInfo.xml (flat or
//                hierarchical list of all metadata objects).
//   • object   — object-by-object XML dump WITHOUT ConfigDumpInfo.xml
//                (root Configuration.xml + type dirs; object defs <Type>/<N>.xml;
//                child structure recovered from the filesystem).
//
// The model is lazy: top level lists groups, groups list objects, objects list
// sections, sections list items. Only what the user expands gets parsed, so a
// ЗУП-scale config stays instant. Parsed artifacts (Configuration.mdo,
// ConfigDumpInfo.xml, per-object .xml) are cached.
//
// Node keys are config-root-relative posix paths: "Catalogs", "Catalogs/Товары",
// "Catalogs/Товары/Формы" (virtual sections use Russian labels as the last
// segment). Leaf items carry an absolute `file` path for the editor.

import { promises as fs, existsSync } from "node:fs";
import { join, posix } from "node:path";
import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------------------
// Constants: display order, labels, icons (mirrors vscode-1c-metadata-viewer)
// ---------------------------------------------------------------------------

const COMMON_GROUPS = [
  ["Subsystems", "Подсистемы", "subsystem"],
  ["CommonModules", "Общие модули", "commonModule"],
  ["SessionParameters", "Параметры сеанса", "sessionParameter"],
  ["Roles", "Роли", "role"],
  ["CommonAttributes", "Общие реквизиты", "attribute"],
  ["ExchangePlans", "Планы обмена", "exchangePlan"],
  ["FilterCriteria", "Критерии отбора", "filterCriteria"],
  ["EventSubscriptions", "Подписки на события", "eventSubscription"],
  ["ScheduledJobs", "Регламентные задания", "scheduledJob"],
  ["FunctionalOptions", "Функциональные опции", "common"],
  ["FunctionalOptionsParameters", "Параметры функциональных опций", "common"],
  ["DefinedTypes", "Определяемые типы", "common"],
  ["SettingsStorages", "Хранилища настроек", "common"],
  ["CommonCommands", "Общие команды", "command"],
  ["CommandGroups", "Группы команд", "common"],
  ["CommonForms", "Общие формы", "form"],
  ["CommonTemplates", "Общие макеты", "template"],
  ["CommonPictures", "Общие картинки", "picture"],
  ["WebServices", "Web-сервисы", "ws"],
  ["HTTPServices", "HTTP-сервисы", "http"],
  ["WSReferences", "WS-ссылки", "wsLink"],
  ["Styles", "Стили", "style"],
];

const MAIN_GROUPS = [
  ["Constants", "Константы", "constant"],
  ["Catalogs", "Справочники", "catalog"],
  ["Documents", "Документы", "document"],
  ["DocumentNumerators", "Нумераторы", "documentNumerator"],
  ["Sequences", "Последовательности", "sequence"],
  ["DocumentJournals", "Журналы документов", "documentJournal"],
  ["Enums", "Перечисления", "enum"],
  ["Reports", "Отчеты", "report"],
  ["DataProcessors", "Обработки", "dataProcessor"],
  ["ChartsOfCharacteristicTypes", "Планы видов характеристик", "chartsOfCharacteristicType"],
  ["ChartsOfAccounts", "Планы счетов", "chartsOfAccount"],
  ["ChartsOfCalculationTypes", "Планы видов расчета", "chartsOfCalculationType"],
  ["InformationRegisters", "Регистры сведений", "informationRegister"],
  ["AccumulationRegisters", "Регистры накопления", "accumulationRegister"],
  ["AccountingRegisters", "Регистры бухгалтерии", "accountingRegister"],
  ["CalculationRegisters", "Регистры расчета", "calculationRegister"],
  ["BusinessProcesses", "Бизнес-процессы", "businessProcess"],
  ["Tasks", "Задачи", "task"],
  ["ExternalDataSources", "Внешние источники данных", "externalDataSource"],
];

const DIRS = new Set([...COMMON_GROUPS, ...MAIN_GROUPS].map(([d]) => d));

// EDT Configuration.mdo property names per type dir (try both spellings —
// EDT's schema has a known "accomulationRegisters" typo).
const MDO_PROP = Object.fromEntries([
  ...COMMON_GROUPS.map(([d]) => [d, camel(d)]),
  ...MAIN_GROUPS.map(([d]) => [d, camel(d)]),
]);
MDO_PROP.AccumulationRegisters = ["accumulationRegisters", "accomulationRegisters"];

function camel(dir) {
  const s = dir.replace(/s$/, "");
  return [s.charAt(0).toLowerCase() + s.slice(1) + "s"];
}

// ConfigDumpInfo metadata name prefix per type dir.
const XML_PREFIX = {
  Subsystems: "Subsystem.", CommonModules: "CommonModule.", SessionParameters: "SessionParameter.",
  Roles: "Role.", CommonAttributes: "CommonAttribute.", ExchangePlans: "ExchangePlan.",
  FilterCriteria: "FilterCriterion.", EventSubscriptions: "EventSubscription.",
  ScheduledJobs: "ScheduledJob.", FunctionalOptions: "FunctionalOption.",
  FunctionalOptionsParameters: "FunctionalOptionsParameter.", DefinedTypes: "DefinedType.",
  SettingsStorages: "SettingsStorage.", CommonCommands: "CommonCommand.",
  CommandGroups: "CommandGroup.", CommonForms: "CommonForm.", CommonTemplates: "CommonTemplate.",
  CommonPictures: "CommonPicture.", WebServices: "WebService.", HTTPServices: "HTTPService.",
  WSReferences: "WSReference.", Styles: "Style.", Constants: "Constant.",
  Catalogs: "Catalog.", Documents: "Document.", DocumentNumerators: "DocumentNumerator.",
  Sequences: "Sequence.", DocumentJournals: "DocumentJournal.", Enums: "Enum.",
  Reports: "Report.", DataProcessors: "DataProcessor.",
  ChartsOfCharacteristicTypes: "ChartOfCharacteristicTypes.", ChartsOfAccounts: "ChartOfAccounts.",
  ChartsOfCalculationTypes: "ChartOfCalculationTypes.", InformationRegisters: "InformationRegister.",
  AccumulationRegisters: "AccumulationRegister.", AccountingRegisters: "AccountingRegister.",
  CalculationRegisters: "CalculationRegister.", BusinessProcesses: "BusinessProcess.",
  Tasks: "Task.", ExternalDataSources: "ExternalDataSource.",
};

// 1C metadata name → dump folder path (same table as the reference's CreatePath).
function createPath(name) {
  return name
    .replace(/Subsystem\./g, "Subsystems/")
    .replace(/CommonModule\./g, "CommonModules/")
    .replace(/SessionParameter\./g, "SessionParameters/")
    .replace(/Role\./g, "Roles/")
    .replace(/CommonAttribute\./g, "CommonAttributes/")
    .replace(/ExchangePlan\./g, "ExchangePlans/")
    .replace(/FilterCriterion\./g, "FilterCriteria/")
    .replace(/EventSubscription\./g, "EventSubscriptions/")
    .replace(/ScheduledJob\./g, "ScheduledJobs/")
    .replace(/FunctionalOption\./g, "FunctionalOptions/")
    .replace(/FunctionalOptionsParameter\./g, "FunctionalOptionsParameters/")
    .replace(/DefinedType\./g, "DefinedTypes/")
    .replace(/SettingsStorage\./g, "SettingsStorages/")
    .replace(/CommonCommand\./g, "CommonCommands/")
    .replace(/CommandGroup\./g, "CommandGroups/")
    .replace(/CommonForm\./g, "CommonForms/")
    .replace(/CommonTemplate\./g, "CommonTemplates/")
    .replace(/CommonPicture\./g, "CommonPictures/")
    .replace(/WebService\./g, "WebServices/")
    .replace(/HTTPService\./g, "HTTPServices/")
    .replace(/WSReference\./g, "WSReferences/")
    .replace(/StyleItem\./g, "StyleItems/")
    .replace(/Style\./g, "Styles/")
    .replace(/Constant\./g, "Constants/")
    .replace(/Catalog\./g, "Catalogs/")
    .replace(/Document\./g, "Documents/")
    .replace(/DocumentNumerator\./g, "DocumentNumerators/")
    .replace(/Sequence\./g, "Sequences/")
    .replace(/DocumentJournal\./g, "DocumentJournals/")
    .replace(/Enum\./g, "Enums/")
    .replace(/Report\./g, "Reports/")
    .replace(/DataProcessor\./g, "DataProcessors/")
    .replace(/ChartOfCharacteristicTypes\./g, "ChartsOfCharacteristicTypes/")
    .replace(/ChartOfAccounts\./g, "ChartsOfAccounts/")
    .replace(/ChartOfCalculationTypes\./g, "ChartsOfCalculationTypes/")
    .replace(/InformationRegister\./g, "InformationRegisters/")
    .replace(/AccumulationRegister\./g, "AccumulationRegisters/")
    .replace(/AccountingRegister\./g, "AccountingRegisters/")
    .replace(/CalculationRegister\./g, "CalculationRegisters/")
    .replace(/BusinessProcess\./g, "BusinessProcesses/")
    .replace(/Task\./g, "Tasks/")
    .replace(/ExternalDataSource\./g, "ExternalDataSources/")
    .replace(/\.Template\./g, "/Templates/");
}

// ---------------------------------------------------------------------------
// XML parsing helpers
// ---------------------------------------------------------------------------

function makeParser() {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "$_",
    trimValues: false,
    // Repeated <Metadata> inside ConfigDumpInfo (both flat and hierarchical).
    isArray: (name, jpath) => jpath.endsWith(".Metadata"),
  });
}

// Strip namespace prefix: "v8:item" → "item", "mdclass:Catalog" → "Catalog".
function tag(name) {
  const i = String(name).indexOf(":");
  return i === -1 ? name : name.slice(i + 1);
}

function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

// Extract list items from an EDT-style container: either a direct array of
// items, or a plural wrapper holding singular <itemTag> children.
function mdoItems(node, itemTag) {
  if (node == null) return [];
  const out = [];
  for (const x of asArray(node)) {
    if (x && typeof x === "object") {
      const kids = x[itemTag] ?? x[itemTag + "s"];
      if (kids != null) out.push(...asArray(kids));
      else out.push(x);
    } else {
      out.push(x);
    }
  }
  return out;
}

// Synonym from the 1C localized-content shapes used across formats.
//   {v8:item:{v8:lang,v8:content}}  (XML dump)
//   {item:[{lang,value}]}           (EDT .mdo)
//   {value:"..."}                   (EDT Configuration.mdo)
function getSynonym(node) {
  if (!node) return "";
  const syn = node.Synonym ?? node.synonym;
  if (!syn) return "";
  const items = asArray(syn["v8:item"] ?? syn.item ?? syn["v8:Item"]);
  for (const it of items) {
    const v = it["v8:content"] ?? it.content ?? it["v8:value"] ?? it.value;
    if (v != null && String(v).trim()) return String(v);
  }
  if (syn["v8:value"] ?? syn.value) return String(syn["v8:value"] ?? syn.value);
  return "";
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

async function dirsAt(root) {
  try {
    const names = await fs.readdir(root, { withFileTypes: true });
    return new Set(names.filter((d) => d.isDirectory()).map((d) => d.name));
  } catch {
    return new Set();
  }
}

async function fileExists(root, rel) {
  try {
    await fs.access(join(root, ...rel.split("/")));
    return true;
  } catch {
    return false;
  }
}

// Find the 1C configuration inside `root` (scan depth ≤ 3, shallowest wins).
// Returns { format: "edt" | "xml" | "object", configRoot } or null.
export async function detectConfig(root) {
  const queue = [{ dir: root, depth: 0 }];
  const seen = new Set();
  let best = null; // { format, dir, depth }

  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (depth > 3 || seen.has(dir)) continue;
    seen.add(dir);

    const rel = dir === root ? "" : dir.slice(root.length + 1);
    const mdoOk =
      (await fileExists(dir, "Configuration/Configuration.mdo")) ||
      (rel && (await fileExists(dir, "Configuration.mdo")));
    if (mdoOk && (!best || best.depth > depth)) {
      best = { format: "edt", dir, depth };
      continue; // an EDT project is self-contained; don't descend further
    }
    const cdiOk = await fileExists(dir, "ConfigDumpInfo.xml");
    const cfgXmlOk = await fileExists(dir, "Configuration.xml");
    if (cdiOk && (!best || best.depth > depth)) {
      best = { format: "xml", dir, depth };
    } else if (cfgXmlOk && !cdiOk) {
      const subs = await dirsAt(dir);
      if ([...DIRS].some((d) => subs.has(d)) && (!best || best.depth > depth)) {
        best = { format: "object", dir, depth };
      }
    }
    if (depth < 3) {
      const subs = await dirsAt(dir);
      for (const s of subs) {
        if (s === ".git" || s === "node_modules" || s.startsWith(".")) continue;
        queue.push({ dir: join(dir, s), depth: depth + 1 });
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The lazy model
// ---------------------------------------------------------------------------

export class MetaModel {
  constructor(root) {
    this.root = root;
    this.format = null;
    this.configRoot = null;
    this.ready = null;
    // caches
    this.mdo = null; // parsed Configuration.mdo (edt)
    this.flat = null; // flattened ConfigDumpInfo entries (xml)
    this.objCache = new Map(); // object def (edt .mdo / object .xml) by key
    this.groupsCache = null; // [ {key,label,icon,count,hasCommon} ]
  }

  async init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const det = await detectConfig(this.root);
      if (!det) {
        throw new Error("Конфигурация 1С не найдена (искал Configuration.mdo, ConfigDumpInfo.xml, Configuration.xml)");
      }
      this.format = det.format;
      this.configRoot = det.dir;
      await this.buildGroups();
    })();
    return this.ready;
  }

  // --- group listing ------------------------------------------------------

  async buildGroups() {
    if (this.format === "edt") await this.ensureMdo();
    const common = [];
    for (const [dir, label, icon] of COMMON_GROUPS) {
      const n = await this.groupCount(dir);
      if (n > 0) common.push({ key: dir, label, icon, count: n });
    }
    // Root-level modules of the configuration itself (XML dumps keep them in Ext/).
    const ext = join(this.configRoot, "Ext");
    const rootModules = this.format !== "edt"
      ? ["ManagedApplicationModule.bsl", "SessionModule.bsl", "ExternalConnectionModule.bsl"]
          .filter((f) => existsSync(join(ext, f)))
          .map((f) => ({
            key: null,
            label: MODULE_LABELS[f] ?? f.replace(/Module\.bsl$/, ""),
            icon: "commonModule",
            file: join(ext, f),
          }))
      : [];
    const main = [];
    for (const [dir, label, icon] of MAIN_GROUPS) {
      const n = await this.groupCount(dir);
      if (n > 0) main.push({ key: dir, label, icon, count: n });
    }
    const items = [];
    if (rootModules.length) items.push(...rootModules);
    if (common.length) items.push({ key: "Общие", label: "Общие", icon: "common", count: common.length, children: common });
    items.push(...main);
    this.groupsCache = items;
  }

  // Number of objects in a type group, per format.
  async groupCount(dir) {
    if (this.format === "edt") return this.mdoObjects(dir).length;
    if (this.format === "xml") {
      await this.ensureFlat();
      const p = XML_PREFIX[dir];
      return p ? this.flat.filter((e) => e.name.startsWith(p) && e.parts.length === 2).length : 0;
    }
    // object: count folders + standalone definition files
    const abs = join(this.configRoot, dir);
    let names;
    try {
      names = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return 0;
    }
    const defs = new Set(names.filter((d) => d.isFile() && d.name.endsWith(".xml")).map((d) => d.name.slice(0, -4)));
    const dirs = names.filter((d) => d.isDirectory()).map((d) => d.name);
    return new Set([...dirs, ...defs]).size;
  }

  // --- object listing ------------------------------------------------------

  async listObjects(dir) {
    let out;
    if (this.format === "edt") {
      const names = this.mdoObjects(dir);
      out = names.map((name) => ({
        key: dir + "/" + name,
        label: name,
        icon: this.groupIcon(dir),
        count: 1,
      }));
    } else if (this.format === "xml") {
      await this.ensureFlat();
      const p = XML_PREFIX[dir];
      const seen = new Set();
      out = [];
      for (const e of this.flat) {
        if (!e.name.startsWith(p) || e.parts.length !== 2) continue;
        const objName = e.parts[1];
        if (seen.has(objName)) continue;
        seen.add(objName);
        out.push({ key: dir + "/" + objName, label: objName, icon: this.groupIcon(dir), count: 1 });
      }
    } else {
      // object format: folders + standalone defs, deduped
      const abs = join(this.configRoot, dir);
      let names;
      try {
        names = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        return [];
      }
      const seen = new Set();
      out = [];
      for (const d of names) {
        const objName = d.isDirectory() ? d.name : d.isFile() && d.name.endsWith(".xml") ? d.name.slice(0, -4) : null;
        if (!objName || seen.has(objName)) continue;
        seen.add(objName);
        out.push({ key: dir + "/" + objName, label: objName, icon: this.groupIcon(dir), count: 1 });
      }
      out.sort((a, b) => a.label.localeCompare(b.label, "ru"));
    }
    // Module-only types (общий модуль, подписка на событие, регламентное
    // задание, ...) open straight from their file — no extra nesting level.
    const dm = DIRECT_MODULES[dir];
    if (dm) {
      for (const item of out) {
        const p = join(this.configRoot, dir, item.label, ...dm);
        if (existsSync(p)) {
          item.key = null;
          item.file = p;
          item.count = undefined;
        }
      }
    }
    return out;
  }

  // --- object sections -----------------------------------------------------

  async listSections(objKey) {
    const [dir, objName] = splitObjKey(objKey);
    const def = await this.objectDef(dir, objName);
    const sections = [];
    const push = (key, label, icon, items) => {
      if (items && items.length) sections.push({ key: objKey + "/" + key, label, icon, count: items.length, items });
    };

    const spec = SECTION_ORDER[dir] ?? ["attributes", "tabularSections", "forms", "commands", "templates"];
    for (const s of spec) {
      const items = await this.sectionItems(dir, objName, objKey, def, s);
      if (!items.length) continue;
      const meta = SECTION_META[s];
      push(s, meta.label, meta.icon, items);
    }

    // Module files present on disk (Ext/*.bsl) — the reason this whole tree exists.
    const modules = this.moduleLeafs(dir, objName);
    if (modules.length) push("Модули", "Модули", "commonModule", modules);
    return sections;
  }

  async sectionItems(dir, objName, objKey, def, s) {
    const src = def[s];
    if (!src || !src.length) return [];
    const icon = SECTION_META[s].itemIcon;
    switch (s) {
      case "tabularSections":
        return src.map((ts) => ({ key: objKey + "/tabularSections/" + ts.name, label: ts.name, icon: "tabularSection" }));
      case "operations":
        return src.map((op) => ({ key: objKey + "/operations/" + op.name, label: op.name, icon: "operation" }));
      case "urlTemplates":
        return src.map((u) => ({ key: objKey + "/urlTemplates/" + u.name, label: u.name, icon: "urlTemplate" }));
      case "forms": {
        const out = [];
        for (const f of src) {
          const file = this.formModuleFile(dir, objName, f.name) ?? this.objFile(dir, objName, "Forms", f.name + ".xml");
          out.push({ key: null, label: f.name, icon: "form", file });
        }
        return out;
      }
      case "commands": {
        const out = [];
        for (const c of src) {
          const file =
            this.objFile(dir, objName, "Commands", c.name, "Ext", "CommandModule.bsl") ??
            this.objFile(dir, objName, "Commands", c.name + ".xml");
          out.push({ key: null, label: c.name, icon: "command", file });
        }
        return out;
      }
      case "templates":
        return src.map((t) => ({
          key: null,
          label: t.name,
          icon: "template",
          file: this.objFile(dir, objName, "Templates", t.name + ".xml"),
        }));
      default:
        return src.map((x) => ({ key: null, label: x.name, icon }));
    }
  }

  // --- object definitions (format-specific) -------------------------------

  async objectDef(dir, objName) {
    const cacheKey = dir + "/" + objName;
    if (this.objCache.has(cacheKey)) return this.objCache.get(cacheKey);
    let def = { name: objName };
    try {
      if (this.format === "edt") {
        const p = join(this.configRoot, dir, objName, objName + ".mdo");
        if (existsSync(p)) {
          const root = makeParser().parse(await fs.readFile(p, "utf-8"));
          const el = root[Object.keys(root).find((k) => k !== "?xml")];
          def = this.fromMdoElement(el);
        }
      } else if (this.format === "xml") {
        // ConfigDumpInfo.xml is the authoritative source of object structure.
        await this.ensureFlat();
        def = this.defFromFlat(dir, objName);
        def = await this.mergeFolderChildren(dir, objName, def);
      } else {
        const p = join(this.configRoot, dir, objName + ".xml");
        if (existsSync(p)) {
          const root = makeParser().parse(await fs.readFile(p, "utf-8"));
          const md = root.MetaDataObject;
          const el = md ? md[Object.keys(md)[0]] : null;
          if (el) def = this.fromXmlDumpElement(el);
        }
        // XML-dump formats also carry a folder on disk; use it as an
        // additional source for forms/commands/templates when the def lacks them.
        def = await this.mergeFolderChildren(dir, objName, def);
      }
    } catch (e) {
      console.error("[dsh-bsl-editor] parse " + cacheKey, e);
    }
    this.objCache.set(cacheKey, def);
    if (this.objCache.size > 600) {
      const first = this.objCache.keys().next().value;
      this.objCache.delete(first);
    }
    return def;
  }

  // Build the unified def from the flattened ConfigDumpInfo list.
  // Flat entries: "Catalog.Товары.Attribute.Реквизит" (parts.length 4),
  // "Catalog.Товары.TabularSection.ТЧ.Attribute.Рекв" (6), etc.
  defFromFlat(dir, objName) {
    const base = XML_PREFIX[dir] + objName + ".";
    const items = (seg, depth) =>
      this.flat
        .filter((e) => e.name.startsWith(base + seg + ".") && e.parts.length === depth)
        .map((e) => ({ name: e.parts[depth - 1] }));
    const def = { name: objName };
    const flatSections = [
      ["attributes", "Attribute"],
      ["forms", "Form"],
      ["commands", "Command"],
      ["templates", "Template"],
      ["dimensions", "Dimension"],
      ["resources", "Resource"],
      ["enumValues", "EnumValue"],
      ["columns", "Column"],
      ["accountingFlags", "AccountingFlag"],
      ["extDimensionAccountingFlags", "ExtDimensionAccountingFlag"],
      ["addressingAttributes", "AddressingAttribute"],
    ];
    for (const [field, seg] of flatSections) {
      const list = items(seg, 4);
      if (list.length) def[field] = list;
    }
    const ts = items("TabularSection", 4);
    if (ts.length) {
      def.tabularSections = ts.map((t) => ({
        name: t.name,
        attributes: items("TabularSection." + t.name + ".Attribute", 6),
      }));
    }
    const ops = items("Operation", 4);
    if (ops.length) {
      def.operations = ops.map((o) => ({
        name: o.name,
        parameters: items("Operation." + o.name + ".Parameter", 6),
      }));
    }
    const urls = items("URLTemplate", 4);
    if (urls.length) {
      def.urlTemplates = urls.map((u) => ({
        name: u.name,
        methods: items("URLTemplate." + u.name + ".Method", 6),
      }));
    }
    return def;
  }

  // EDT .mdo element → unified def. Lists are wrapped in plural containers
  // (<attributes><attribute .../>...</attributes>); single items may parse as
  // an object instead of an array, so extraction is tolerant of both shapes.
  fromMdoElement(el) {
    if (!el) return { name: "" };
    const def = { name: el.name ?? "" };
    const ITEM_TAGS = {
      attributes: "attribute", tabularSections: "tabularSection", forms: "form",
      commands: "command", templates: "template", dimensions: "dimension",
      resources: "resource", enumValues: "enumValue", columns: "column",
      accountingFlags: "accountingFlag", extDimensionAccountingFlags: "extDimensionAccountingFlag",
      addressingAttributes: "addressingAttribute", operations: "operation",
      urlTemplates: "urlTemplate",
    };
    for (const [field, itemTag] of Object.entries(ITEM_TAGS)) {
      const items = mdoItems(el[field], itemTag);
      if (!items.length) continue;
      def[field] = items.map((x) => {
        const o = { name: x.name ?? x["$_name"] ?? "" };
        if (field === "tabularSections") o.attributes = mdoItems(x.attributes, "attribute").map((a) => ({ name: a.name ?? "" }));
        if (field === "operations") o.parameters = mdoItems(x.parameters, "parameter").map((p) => ({ name: p.name ?? "" }));
        if (field === "urlTemplates") o.methods = mdoItems(x.methods, "method").map((m) => ({ name: m.name ?? "" }));
        return o;
      });
    }
    return def;
  }

  // Object-by-object dump .xml (MetaDataObject) → unified def.
  fromXmlDumpElement(el) {
    const def = { name: el.Properties?.Name ?? "" };
    const kids = (listName, itemTag) => {
      const list = el[listName];
      if (!list) return null;
      return asArray(list[itemTag] ?? list).map((x) => {
        const o = { name: x.Name ?? x["$_name"] ?? "" };
        if (x.Attributes) o.attributes = asArray(x.Attributes.Attribute).map((a) => ({ name: a.Name ?? "" }));
        return o;
      });
    };
    def.attributes = kids("Attributes", "Attribute");
    def.tabularSections = kids("TabularSections", "TabularSection");
    def.forms = kids("Forms", "Form");
    def.commands = kids("Commands", "Command");
    def.templates = kids("Templates", "Template");
    def.dimensions = kids("Dimensions", "Dimension");
    def.resources = kids("Resources", "Resource");
    def.enumValues = kids("EnumValues", "EnumValue") ?? kids("Values", "Value");
    def.columns = kids("Columns", "Column");
    def.accountingFlags = kids("AccountingFlags", "AccountingFlag");
    def.extDimensionAccountingFlags = kids("ExtDimensionAccountingFlags", "ExtDimensionAccountingFlag");
    def.addressingAttributes = kids("AddressingAttributes", "AddressingAttribute");
    return def;
  }

  // Folders on disk fill in forms/commands/templates even when the def xml
  // carries only Properties (the hrm1 dump variant).
  async mergeFolderChildren(dir, objName, def) {
    const base = join(this.configRoot, dir, objName);
    const add = async (field, sub, itemTag, labelFile) => {
      if (def[field]) return;
      try {
        const names = await fs.readdir(join(base, sub));
        def[field] = names
          .filter((n) => n.endsWith(".xml"))
          .map((n) => ({ name: n.slice(0, -4) }));
        if (labelFile && def[field].length) {
          // Form folders carry the module under <Name>/Ext/Form/Module.bsl
        }
      } catch {
        def[field] = [];
      }
    };
    await add("forms", "Forms", "Form");
    await add("commands", "Commands", "Command");
    await add("templates", "Templates", "Template");
    return def;
  }

  // --- file mapping --------------------------------------------------------

  objFile(dir, objName, ...segs) {
    const p = join(this.configRoot, dir, objName, ...segs);
    return existsSync(p) ? p : null;
  }

  formModuleFile(dir, objName, formName) {
    return this.objFile(dir, objName, "Forms", formName, "Ext", "Form", "Module.bsl");
  }

  moduleLeafs(dir, objName) {
    const base = join(this.configRoot, dir, objName, "Ext");
    if (!existsSync(base)) return [];
    const out = [];
    for (const [file, label] of Object.entries(MODULE_FILES)) {
      if (existsSync(join(base, file))) out.push({ key: null, label, icon: "commonModule", file: join(base, file) });
    }
    const predef = join(base, "Predefined.xml");
    if (existsSync(predef)) out.push({ key: null, label: "Предопределённые", icon: "common", file: predef });
    return out;
  }

  // --- EDT helpers ---------------------------------------------------------

  async ensureMdo() {
    if (this.mdo) return;
    const p = join(this.configRoot, "Configuration", "Configuration.mdo");
    const root = makeParser().parse(await fs.readFile(p, "utf-8"));
    this.mdo = root["mdclass:Configuration"] ?? root.Configuration ?? {};
  }

  mdoObjects(dir) {
    const props = MDO_PROP[dir] ?? [camel(dir)[0]];
    for (const prop of props) {
      const arr = asArray(this.mdo[prop]);
      if (arr.length) return arr.map((x) => x ?? "");
    }
    return [];
  }

  // --- XML (ConfigDumpInfo) helpers ----------------------------------------

  async ensureFlat() {
    if (this.flat) return;
    const p = join(this.configRoot, "ConfigDumpInfo.xml");
    const root = makeParser().parse(await fs.readFile(p, "utf-8"));
    const list = [];
    const walk = (nodes) => {
      for (const n of asArray(nodes)) {
        const name = n["$_name"];
        if (name) list.push({ name, parts: name.split("."), id: n["$_id"] ?? "" });
        if (n.Metadata) walk(n.Metadata);
      }
    };
    walk(root.ConfigDumpInfo?.ConfigVersions?.Metadata);
    this.flat = list;
  }

  groupIcon(dir) {
    return [...COMMON_GROUPS, ...MAIN_GROUPS].find(([d]) => d === dir)?.[2] ?? "common";
  }

  // --- search ---------------------------------------------------------------

  async search(q) {
    await this.init();
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const out = [];
    const seen = new Set();
    for (const g of this.groupsCache ?? []) {
      if (g.children) continue; // "Общие" — its groups are listed separately below
      if (g.key && g.count) {
        const objs = await this.listObjects(g.key);
        for (const o of objs) {
          if (o.label.toLowerCase().includes(needle)) {
            if (seen.has(o.key)) continue;
            seen.add(o.key);
            out.push({ key: o.key, label: o.label, icon: o.icon });
            if (out.length >= 300) return out;
          }
        }
      } else if (g.file) {
        if (g.label.toLowerCase().includes(needle)) out.push(g);
      }
    }
    // "Общие" subgroups
    const common = (this.groupsCache ?? []).find((g) => g.key === "Общие");
    if (common) {
      for (const sub of common.children ?? []) {
        const objs = await this.listObjects(sub.key);
        for (const o of objs) {
          if (o.label.toLowerCase().includes(needle)) {
            if (seen.has(o.key)) continue;
            seen.add(o.key);
            out.push({ key: o.key, label: o.label, icon: o.icon });
            if (out.length >= 300) return out;
          }
        }
      }
    }
    return out;
  }

  // --- top-level dispatch ----------------------------------------------------

  async list(key) {
    await this.init();
    key = String(key || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!key) return { items: this.groupsCache ?? [] };
    if (key === "Общие") {
      const g = (this.groupsCache ?? []).find((x) => x.key === "Общие");
      return { items: g?.children ?? [] };
    }
    const segs = key.split("/");
    if (segs.length === 1) return { items: await this.listObjects(segs[0]) };
    if (segs.length === 2) return { items: await this.listSections(key) };
    const objKey = segs.slice(0, 2).join("/");
    const [dir, objName] = splitObjKey(objKey);
    if (segs.length === 3) {
      // A section itself ("Catalogs/Товары/forms") — return its items.
      const section = segs[2];
      if (section === "Модули") return { items: await this.moduleLeafs(dir, objName) };
      if (!SECTION_META[section]) return { items: [] };
      const def = await this.objectDef(dir, objName);
      return { items: await this.sectionItems(dir, objName, objKey, def, section) };
    }
    // deeper: a section item with nested children (tabular section attributes,
    // web-service operation parameters, ...) — resolve from the parent object def
    const def = await this.objectDef(dir, objName);
    const section = segs[2];
    const meta = SECTION_META[section];
    if (!meta) return { items: [] };
    const src = def[section] ?? [];
    const item = src.find((x) => x.name === segs[3]);
    if (!item) return { items: [] };
    const children = item.attributes ?? item.parameters ?? item.methods ?? [];
    return {
      items: children.map((c) => ({ key: null, label: c.name, icon: meta.itemIcon })),
    };
  }
}

function splitObjKey(key) {
  const i = key.indexOf("/");
  return [key.slice(0, i), key.slice(i + 1)];
}

// ---------------------------------------------------------------------------
// Section specs
// ---------------------------------------------------------------------------

const SECTION_META = {
  attributes: { label: "Реквизиты", icon: "attribute", itemIcon: "attribute" },
  tabularSections: { label: "Табличные части", icon: "tabularSection", itemIcon: "tabularSection" },
  forms: { label: "Формы", icon: "form", itemIcon: "form" },
  commands: { label: "Команды", icon: "command", itemIcon: "command" },
  templates: { label: "Макеты", icon: "template", itemIcon: "template" },
  dimensions: { label: "Измерения", icon: "dimension", itemIcon: "dimension" },
  resources: { label: "Ресурсы", icon: "resource", itemIcon: "resource" },
  enumValues: { label: "Значения", icon: "attribute", itemIcon: "attribute" },
  columns: { label: "Графы", icon: "column", itemIcon: "column" },
  accountingFlags: { label: "Признаки учета", icon: "accountingFlag", itemIcon: "accountingFlag" },
  extDimensionAccountingFlags: { label: "Признаки учета субконто", icon: "extDimensionAccountingFlag", itemIcon: "extDimensionAccountingFlag" },
  addressingAttributes: { label: "Реквизиты адресации", icon: "attribute", itemIcon: "attribute" },
  operations: { label: "Операции", icon: "operation", itemIcon: "operation" },
  urlTemplates: { label: "Шаблоны URL", icon: "urlTemplate", itemIcon: "urlTemplate" },
  Модули: { label: "Модули", icon: "commonModule", itemIcon: "commonModule" },
};

const SECTION_ORDER = {
  Catalogs: ["attributes", "tabularSections", "forms", "commands", "templates"],
  Documents: ["attributes", "tabularSections", "forms", "commands", "templates"],
  Reports: ["attributes", "tabularSections", "forms", "commands", "templates"],
  DataProcessors: ["attributes", "tabularSections", "forms", "commands", "templates"],
  ExchangePlans: ["attributes", "tabularSections", "forms", "commands", "templates"],
  BusinessProcesses: ["attributes", "tabularSections", "forms", "commands", "templates"],
  ChartsOfCharacteristicTypes: ["attributes", "tabularSections", "forms", "commands", "templates"],
  ChartsOfCalculationTypes: ["attributes", "tabularSections", "forms", "commands", "templates"],
  InformationRegisters: ["dimensions", "resources", "attributes", "forms", "commands", "templates"],
  AccumulationRegisters: ["dimensions", "resources", "attributes", "forms", "commands", "templates"],
  AccountingRegisters: ["dimensions", "resources", "attributes", "forms", "commands", "templates"],
  CalculationRegisters: ["dimensions", "resources", "attributes", "forms", "commands", "templates"],
  DocumentJournals: ["columns", "forms", "commands", "templates"],
  Enums: ["enumValues", "forms", "commands", "templates"],
  ChartsOfAccounts: ["accountingFlags", "extDimensionAccountingFlags", "attributes", "tabularSections", "forms", "commands", "templates"],
  Tasks: ["addressingAttributes", "attributes", "tabularSections", "forms", "commands", "templates"],
  WebServices: ["operations"],
  HTTPServices: ["urlTemplates"],
};

const MODULE_FILES = {
  "ObjectModule.bsl": "Модуль объекта",
  "ManagerModule.bsl": "Модуль менеджера",
  "RecordSetModule.bsl": "Модуль набора записей",
  "RecordModule.bsl": "Модуль записи",
  "ValueManagerModule.bsl": "Модуль менеджера значения",
  "Module.bsl": "Модуль объекта (legacy)",
};

// Object types that ARE a single module file: the tree item opens the file
// directly instead of nesting a «Модули» section.
const DIRECT_MODULES = {
  CommonModules: ["Ext", "Module.bsl"],
  EventSubscriptions: ["Ext", "EventSubscriptionModule.bsl"],
  ScheduledJobs: ["Ext", "ScheduledJobModule.bsl"],
  WebServices: ["Ext", "Module.bsl"],
  HTTPServices: ["Ext", "Module.bsl"],
};

const MODULE_LABELS = {
  "ManagedApplicationModule.bsl": "Модуль приложения",
  "SessionModule.bsl": "Модуль сеанса",
  "ExternalConnectionModule.bsl": "Модуль внешнего соединения",
};

export const META_ICON_NAMES = new Set([
  ...COMMON_GROUPS.map(([, , i]) => i),
  ...MAIN_GROUPS.map(([, , i]) => i),
  ...Object.values(SECTION_META).flatMap((m) => [m.icon, m.itemIcon]),
  "operation", "parameter", "urlTemplate", "commonModule",
]);
