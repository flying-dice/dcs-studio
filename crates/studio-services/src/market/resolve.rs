//! studio::market dependency resolution (model studio::market `Library.ResolvePlan`,
//! issue #10): walk a mod's transitive `[[dependencies]]` — each another
//! Marketplace mod (`owner/name`) — into a dependency-before-dependent install
//! plan. The decisions live here, not in the fetcher: a dependency that is a
//! LIBRARY is refused (libraries are bundled at build time via lua-cargo, never
//! installed into the sim); a CYCLE is refused; a REQUIRED dependency that can't
//! be resolved fails the whole resolve, while an OPTIONAL one is dropped with a
//! warning; a dependency whose latest release tag doesn't satisfy its `version`
//! constraint is KEPT with a warning (the Marketplace only ever serves the latest
//! release). The network sits behind [`ModSource`] so the walk is unit-tested
//! against a fake graph with no GitHub round-trips.

use std::collections::BTreeMap;

use dcs_studio_project::DependencyRule;

/// The facts the resolver needs about one mod (its manifest dependencies, latest
/// release tag, library flag, and whether it ships an installable manifest at
/// all) — gathered from GitHub in production, a map in tests.
#[derive(Clone, Debug)]
pub struct ModFacts {
    /// The repo carries `dcs-studio-library` — depending on it is refused.
    pub is_library: bool,
    /// The latest release tag, for version-constraint checks; `None` when the
    /// repo has no release.
    pub latest_tag: Option<String>,
    /// The mod's own `[[dependencies]]`, walked transitively.
    pub deps: Vec<DependencyRule>,
    /// Whether the mod ships an installable `dcs-studio.toml` release asset — a
    /// dependency without one can't be installed.
    pub installable: bool,
}

/// Where the resolver reads mod facts and install state. `id` is `owner/name`.
pub trait ModSource {
    /// Facts for `owner/name`, or an error when the repo/release can't be fetched
    /// (network, 404). The resolver turns a fetch error into a required-fail or
    /// an optional-skip per the declaring `[[dependencies]]` entry.
    fn facts(&self, owner: &str, name: &str) -> Result<ModFacts, String>;

    /// Whether `owner/name` is already recorded in the install ledger — its
    /// payload (and its own already-resolved subtree) is on disk, so its link
    /// step is skipped and its dependencies are not re-walked.
    fn is_installed(&self, id: &str) -> bool;
}

/// One node of a resolved install plan (model studio::market `PlanNode`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanNode {
    /// The mod's `owner/name`.
    pub id: String,
    /// The `owner/name` ids this node declares as dependencies — recorded in the
    /// ledger so uninstall can refcount + garbage-collect.
    pub deps: Vec<String>,
    /// True when a satisfying copy is already installed (its link step is
    /// skipped, only its ledger edges are refreshed).
    pub already_installed: bool,
    /// Version-mismatch / skipped-optional notes raised resolving this node.
    pub warnings: Vec<String>,
}

/// A resolve failure carrying whether it is FATAL regardless of an `optional`
/// flag (a cycle or a library dependency — never silently skipped) or merely a
/// resolution failure an optional dependency may swallow.
struct ResolveError {
    fatal: bool,
    msg: String,
}

impl ResolveError {
    fn fatal(msg: String) -> Self {
        Self { fatal: true, msg }
    }
    fn soft(msg: String) -> Self {
        Self { fatal: false, msg }
    }
}

/// Split a dependency `id` into `(owner, name)`; `None` when it is not a single
/// `owner/name` pair.
fn split_id(id: &str) -> Option<(&str, &str)> {
    let (owner, name) = id.split_once('/')?;
    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }
    Some((owner, name))
}

/// Resolve the transitive dependency graph rooted at `owner/name` into a
/// dependency-before-dependent plan (the root is the LAST node). See the module
/// docs for the decisions. Returns the first fatal/required failure as `Err`.
pub fn resolve(owner: &str, name: &str, src: &dyn ModSource) -> Result<Vec<PlanNode>, String> {
    let mut r = Resolver {
        src,
        order: Vec::new(),
        emitted: BTreeMap::new(),
        tags: BTreeMap::new(),
        stack: Vec::new(),
    };
    r.visit(owner, name, true).map_err(|e| e.msg)?;
    Ok(r.order)
}

struct Resolver<'a> {
    src: &'a dyn ModSource,
    /// Plan nodes in post-order (dependency before dependent).
    order: Vec<PlanNode>,
    /// id → already emitted (diamond/shared dependency dedup).
    emitted: BTreeMap<String, ()>,
    /// id → its latest release tag (for version checks at the declaring edge).
    tags: BTreeMap<String, Option<String>>,
    /// The current DFS path — membership is the cycle check.
    stack: Vec<String>,
}

impl Resolver<'_> {
    fn visit(&mut self, owner: &str, name: &str, is_root: bool) -> Result<(), ResolveError> {
        let id = format!("{owner}/{name}");

        // Cycle: a mod reachable from itself. Always fatal — never an optional skip.
        if self.stack.contains(&id) {
            let mut path = self.stack.clone();
            path.push(id.clone());
            return Err(ResolveError::fatal(format!(
                "dependency cycle: {}",
                path.join(" → ")
            )));
        }
        // Already placed by another branch (shared dependency) — done.
        if self.emitted.contains_key(&id) {
            return Ok(());
        }

        // A non-root mod already installed is a satisfied leaf: its payload and
        // its own resolved subtree are on disk, so don't re-walk or re-fetch it.
        //
        // DELIBERATE (v1): the leaf carries no tag, so `version_warning` is a
        // no-op for it — a constraint against an ALREADY-INSTALLED dependency does
        // not warn, whereas one against a freshly-resolved dependency does. The
        // asymmetry is intentional and harmless: the Marketplace serves only a
        // repo's latest release and never replaces an installed copy, so there is
        // no action a warning could prompt here (the install proceeds either way),
        // and the ledger does not record per-mod tags to compare against. If a
        // future slice lets installs upgrade an existing dependency, carry the
        // installed tag here so the same warning fires symmetrically.
        if !is_root && self.src.is_installed(&id) {
            self.tags.insert(id.clone(), None);
            self.emit(PlanNode {
                id,
                deps: Vec::new(),
                already_installed: true,
                warnings: Vec::new(),
            });
            return Ok(());
        }

        let facts = self
            .src
            .facts(owner, name)
            .map_err(|e| ResolveError::soft(format!("cannot resolve {id}: {e}")))?;
        self.tags.insert(id.clone(), facts.latest_tag.clone());

        // A dependency on a library is a category error (the root is guarded by
        // the caller before resolve, so this only fires for dependencies).
        if facts.is_library && !is_root {
            return Err(ResolveError::fatal(format!(
                "{id} is a dcs-studio library — declare it in CargoLua.toml under [dependencies], not as a [[dependencies]] mod"
            )));
        }
        if !facts.installable {
            return Err(ResolveError::soft(format!(
                "{id} has no installable release (no dcs-studio.toml asset)"
            )));
        }

        self.stack.push(id.clone());
        let mut warnings: Vec<String> = Vec::new();
        let mut dep_ids: Vec<String> = Vec::new();
        for dep in &facts.deps {
            match self.visit_dep(dep) {
                Ok(dep_id) => {
                    if let Some(w) = self.version_warning(&dep_id, &dep.version) {
                        warnings.push(w);
                    }
                    dep_ids.push(dep_id);
                }
                Err(e) if e.fatal => {
                    self.stack.pop();
                    return Err(e);
                }
                Err(e) => {
                    // Non-fatal: skip if the dependency is optional, else fail.
                    if dep.optional {
                        warnings.push(format!("skipped optional dependency: {}", e.msg));
                    } else {
                        self.stack.pop();
                        return Err(e);
                    }
                }
            }
        }
        self.stack.pop();

        let already_installed = self.src.is_installed(&id);
        self.emit(PlanNode {
            id,
            deps: dep_ids,
            already_installed,
            warnings,
        });
        Ok(())
    }

    /// Resolve one `[[dependencies]]` edge: validate its id, recurse, and return
    /// the resolved `owner/name`. A malformed id is a soft (optional-skippable)
    /// failure.
    fn visit_dep(&mut self, dep: &DependencyRule) -> Result<String, ResolveError> {
        let Some((owner, name)) = split_id(&dep.id) else {
            return Err(ResolveError::soft(format!(
                "dependency id '{}' is not a valid owner/name",
                dep.id
            )));
        };
        self.visit(owner, name, false)?;
        Ok(format!("{owner}/{name}"))
    }

    fn emit(&mut self, node: PlanNode) {
        self.emitted.insert(node.id.clone(), ());
        self.order.push(node);
    }

    /// A warning when `id`'s latest release tag does not satisfy `req`; `None`
    /// when it satisfies, when either side isn't semver, or when `req` is any
    /// (`*` / empty). Lenient: an uncomparable pair never warns.
    fn version_warning(&self, id: &str, req: &str) -> Option<String> {
        let req = req.trim();
        if req.is_empty() || req == "*" {
            return None;
        }
        let tag = self.tags.get(id)?.as_ref()?;
        let parsed_req = semver::VersionReq::parse(req).ok()?;
        let version = parse_tag(tag)?;
        if parsed_req.matches(&version) {
            None
        } else {
            Some(format!(
                "{id}: latest release {tag} does not satisfy version \"{req}\" — installing {tag} anyway"
            ))
        }
    }
}

/// Parse a release tag as a semver version, tolerating a leading `v`/`V`.
fn parse_tag(tag: &str) -> Option<semver::Version> {
    let trimmed = tag.strip_prefix(['v', 'V']).unwrap_or(tag);
    semver::Version::parse(trimmed).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashSet;

    fn dep(id: &str) -> DependencyRule {
        DependencyRule {
            id: id.to_string(),
            name: String::new(),
            version: String::new(),
            optional: false,
        }
    }

    fn opt_dep(id: &str) -> DependencyRule {
        DependencyRule {
            optional: true,
            ..dep(id)
        }
    }

    fn ver_dep(id: &str, version: &str) -> DependencyRule {
        DependencyRule {
            version: version.to_string(),
            ..dep(id)
        }
    }

    /// A fake graph: `facts` maps id → ModFacts; `missing` ids fail to fetch;
    /// `installed` ids report as already on disk.
    struct Fake {
        facts: BTreeMap<String, ModFacts>,
        installed: HashSet<String>,
        /// Records which ids `facts()` was asked for (to prove an installed dep
        /// is NOT re-fetched).
        fetched: RefCell<Vec<String>>,
    }

    impl Fake {
        fn new() -> Self {
            Self {
                facts: BTreeMap::new(),
                installed: HashSet::new(),
                fetched: RefCell::new(Vec::new()),
            }
        }
        fn with(mut self, id: &str, facts: ModFacts) -> Self {
            self.facts.insert(id.to_string(), facts);
            self
        }
        fn installed(mut self, id: &str) -> Self {
            self.installed.insert(id.to_string());
            self
        }
    }

    fn modfacts(deps: Vec<DependencyRule>) -> ModFacts {
        ModFacts {
            is_library: false,
            latest_tag: Some("v1.0.0".to_string()),
            deps,
            installable: true,
        }
    }

    impl ModSource for Fake {
        fn facts(&self, owner: &str, name: &str) -> Result<ModFacts, String> {
            let id = format!("{owner}/{name}");
            self.fetched.borrow_mut().push(id.clone());
            self.facts
                .get(&id)
                .cloned()
                .ok_or_else(|| format!("404 {id}"))
        }
        fn is_installed(&self, id: &str) -> bool {
            self.installed.contains(id)
        }
    }

    #[test]
    fn a_mod_with_no_dependencies_resolves_to_just_itself() {
        let src = Fake::new().with("o/root", modfacts(vec![]));
        let plan = resolve("o", "root", &src).unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].id, "o/root");
        assert!(plan[0].deps.is_empty());
    }

    #[test]
    fn dependencies_come_before_the_dependent_transitively() {
        // root → a → b ; root → c. Post-order puts every dep before its needer,
        // and the root last.
        let src = Fake::new()
            .with("o/root", modfacts(vec![dep("o/a"), dep("o/c")]))
            .with("o/a", modfacts(vec![dep("o/b")]))
            .with("o/b", modfacts(vec![]))
            .with("o/c", modfacts(vec![]));
        let plan = resolve("o", "root", &src).unwrap();
        let ids: Vec<&str> = plan.iter().map(|n| n.id.as_str()).collect();
        let pos = |id: &str| ids.iter().position(|x| *x == id).unwrap();
        assert!(pos("o/b") < pos("o/a"));
        assert!(pos("o/a") < pos("o/root"));
        assert!(pos("o/c") < pos("o/root"));
        assert_eq!(*ids.last().unwrap(), "o/root");
        // The root records exactly its declared edges.
        let root = plan.iter().find(|n| n.id == "o/root").unwrap();
        assert_eq!(root.deps, vec!["o/a".to_string(), "o/c".to_string()]);
    }

    #[test]
    fn a_shared_dependency_is_emitted_once() {
        // Diamond: root → a → shared, root → b → shared.
        let src = Fake::new()
            .with("o/root", modfacts(vec![dep("o/a"), dep("o/b")]))
            .with("o/a", modfacts(vec![dep("o/shared")]))
            .with("o/b", modfacts(vec![dep("o/shared")]))
            .with("o/shared", modfacts(vec![]));
        let plan = resolve("o", "root", &src).unwrap();
        let shared = plan.iter().filter(|n| n.id == "o/shared").count();
        assert_eq!(shared, 1, "the shared dep appears once");
        assert_eq!(plan.len(), 4);
    }

    #[test]
    fn a_cycle_is_rejected_even_through_optional_edges() {
        // root → a → root, but the back-edge is optional: a cycle is still fatal
        // (never swallowed as an optional skip).
        let src = Fake::new()
            .with("o/root", modfacts(vec![dep("o/a")]))
            .with("o/a", modfacts(vec![opt_dep("o/root")]));
        let err = resolve("o", "root", &src).unwrap_err();
        assert!(err.contains("cycle"), "cycle reported: {err}");
    }

    #[test]
    fn a_self_dependency_is_a_cycle() {
        let src = Fake::new().with("o/root", modfacts(vec![dep("o/root")]));
        let err = resolve("o", "root", &src).unwrap_err();
        assert!(err.contains("cycle"), "self-dep is a cycle: {err}");
    }

    #[test]
    fn a_required_missing_dependency_fails_the_resolve() {
        let src = Fake::new().with("o/root", modfacts(vec![dep("o/gone")]));
        let err = resolve("o", "root", &src).unwrap_err();
        assert!(err.contains("o/gone"), "names the missing dep: {err}");
    }

    #[test]
    fn an_optional_missing_dependency_is_skipped_with_a_warning() {
        let src = Fake::new().with("o/root", modfacts(vec![opt_dep("o/gone")]));
        let plan = resolve("o", "root", &src).unwrap();
        assert_eq!(plan.len(), 1, "only the root installs");
        let root = &plan[0];
        assert!(root.deps.is_empty(), "the optional dep is not an edge");
        assert!(
            root.warnings.iter().any(|w| w.contains("o/gone")),
            "a skip warning is raised: {:?}",
            root.warnings
        );
    }

    #[test]
    fn depending_on_a_library_is_rejected() {
        let lib = ModFacts {
            is_library: true,
            ..modfacts(vec![])
        };
        let src = Fake::new()
            .with("o/root", modfacts(vec![dep("o/lib")]))
            .with("o/lib", lib);
        let err = resolve("o", "root", &src).unwrap_err();
        assert!(err.contains("library"), "library dep refused: {err}");
        assert!(err.contains("CargoLua.toml"), "points at the right place: {err}");
    }

    #[test]
    fn a_library_dependency_is_fatal_even_when_optional() {
        let lib = ModFacts {
            is_library: true,
            ..modfacts(vec![])
        };
        let src = Fake::new()
            .with("o/root", modfacts(vec![opt_dep("o/lib")]))
            .with("o/lib", lib);
        let err = resolve("o", "root", &src).unwrap_err();
        assert!(err.contains("library"), "optional library dep still refused: {err}");
    }

    #[test]
    fn a_version_mismatch_warns_but_still_resolves() {
        let dep_b = ModFacts {
            latest_tag: Some("v2.0.0".to_string()),
            ..modfacts(vec![])
        };
        let src = Fake::new()
            .with("o/root", modfacts(vec![ver_dep("o/b", "^1.0")]))
            .with("o/b", dep_b);
        let plan = resolve("o", "root", &src).unwrap();
        assert_eq!(plan.len(), 2, "the dep still installs");
        let root = plan.iter().find(|n| n.id == "o/root").unwrap();
        assert!(
            root.warnings.iter().any(|w| w.contains("does not satisfy")),
            "a version-mismatch warning is raised: {:?}",
            root.warnings
        );
    }

    #[test]
    fn a_satisfied_version_raises_no_warning() {
        let dep_b = ModFacts {
            latest_tag: Some("v1.4.0".to_string()),
            ..modfacts(vec![])
        };
        let src = Fake::new()
            .with("o/root", modfacts(vec![ver_dep("o/b", "^1.0")]))
            .with("o/b", dep_b);
        let plan = resolve("o", "root", &src).unwrap();
        let root = plan.iter().find(|n| n.id == "o/root").unwrap();
        assert!(root.warnings.is_empty(), "no warning: {:?}", root.warnings);
    }

    #[test]
    fn an_already_installed_dependency_is_a_leaf_and_is_not_refetched() {
        // root → a (installed). `a` itself declares a dep, but since it's already
        // installed we must NOT walk or fetch it.
        let src = Fake::new()
            .with("o/root", modfacts(vec![dep("o/a")]))
            .with("o/a", modfacts(vec![dep("o/should-not-fetch")]))
            .installed("o/a");
        let plan = resolve("o", "root", &src).unwrap();
        let a = plan.iter().find(|n| n.id == "o/a").unwrap();
        assert!(a.already_installed, "marked already installed");
        assert!(a.deps.is_empty(), "its subtree is not re-walked");
        assert!(
            !src.fetched.borrow().iter().any(|f| f == "o/a"),
            "an installed dep is never re-fetched: {:?}",
            src.fetched.borrow()
        );
    }

    #[test]
    fn a_malformed_required_dependency_id_fails() {
        let src = Fake::new().with("o/root", modfacts(vec![dep("not-a-slug")]));
        let err = resolve("o", "root", &src).unwrap_err();
        assert!(err.contains("not a valid owner/name"), "{err}");
    }
}
