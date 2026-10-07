import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
const require = createRequire(import.meta.url);
export function load(file, dependencies = {}) {
  const loaded = { exports: {} };
  const { outputText } = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  runInNewContext(outputText, { module: loaded, exports: loaded.exports,
    require: name => dependencies[name] ?? require(name),
    requestAnimationFrame: callback => callback(), document: { getElementById: () => ({ scrollIntoView() {} }) },
  });
  return loaded.exports;
}
export const ui = load("../app/_components/finser-ui.tsx");
export function nodes(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(node => nodes(node, predicate));
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
export function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (tree == null || typeof tree === "boolean") return "";
  return typeof tree === "object" ? text(tree.props?.children) : String(tree);
}
export function harness(file, props, dependencies = {}) {
  const states=[]; let cursor=0; let tree;
  const hooks={ useMemo: calculate=>calculate(), useState(initial) { const i=cursor++;if (!(i in states))states[i]=initial;return [states[i], next=>{states[i]=typeof next === "function" ? next(states[i]) : next;}]; } };
  const styles = new Proxy({}, { get: (_,name) => String(name) });
  const Console=load(file,{react:hooks,"@/app/_components/finser-ui":ui,"./risk.module.css":{default:styles},"./mora.module.css":{default:styles},...dependencies}).default;
  const render=()=>{cursor=0;tree=Console(props);return renderToStaticMarkup(tree);};
  return {render, tree:()=>tree, click(label) {const button=nodes(tree,n=>(n.type === "button" || n.type === ui.Button) && text(n).includes(label))[0];if(!button)throw Error(`Missing button ${label}`);button.props.onClick();return render();}, filter(label,value) {const wrapper=nodes(tree,n=>n.type === "label" && text(n).startsWith(label))[0];const input=nodes(wrapper,n=>n.type === ui.Input || n.type === ui.Select)[0];input.props.onChange({target:{value}});return render();}, search(value) {const input=nodes(tree,n=>n.type === ui.Input && n.props.placeholder?.startsWith("Buscar"))[0];input.props.onChange({target:{value}});return render();} };
}
