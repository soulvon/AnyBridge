use super::*;

#[test]
fn legacy_routes_receive_deterministic_uid() {
    let mut routes = ProxyRoutes {
        version: 1,
        default_model_id: String::new(),
        routes: vec![ProxyRoute {
            id: "gpt-4o".into(),
            targets: vec![ProxyRouteTarget {
                provider_id: "openai".into(),
                model: "gpt-4o-2024-08-06".into(),
                ..Default::default()
            }],
            ..Default::default()
        }],
        claude_desktop: None,
    };

    normalize_routes(&mut routes);
    assert!(!routes.routes[0].uid.is_empty());
    assert!(routes.routes[0].uid.starts_with("route-"));

    let first_uid = routes.routes[0].uid.clone();
    routes.routes[0].uid = String::new();
    normalize_routes(&mut routes);
    assert_eq!(routes.routes[0].uid, first_uid);
}

#[test]
fn existing_uid_is_preserved_even_when_id_renamed() {
    let mut routes = ProxyRoutes {
        version: 1,
        default_model_id: String::new(),
        routes: vec![ProxyRoute {
            uid: "route-custom-12345".into(),
            id: "gpt-4o-renamed".into(),
            targets: vec![ProxyRouteTarget {
                provider_id: "openai".into(),
                model: "gpt-4o".into(),
                ..Default::default()
            }],
            ..Default::default()
        }],
        claude_desktop: None,
    };

    normalize_routes(&mut routes);
    assert_eq!(routes.routes[0].uid, "route-custom-12345");
}

#[test]
fn different_targets_produce_different_uids() {
    let r1 = ProxyRoute {
        id: "model-a".into(),
        targets: vec![ProxyRouteTarget {
            provider_id: "p1".into(),
            model: "m1".into(),
            ..Default::default()
        }],
        ..Default::default()
    };
    let r2 = ProxyRoute {
        id: "model-a".into(),
        targets: vec![ProxyRouteTarget {
            provider_id: "p2".into(),
            model: "m1".into(),
            ..Default::default()
        }],
        ..Default::default()
    };
    assert_ne!(generate_route_uid(&r1), generate_route_uid(&r2));
}

#[test]
fn claude_desktop_bindings_roundtrip() {
    let mut routes = ProxyRoutes {
        version: 1,
        default_model_id: String::new(),
        routes: vec![],
        claude_desktop: Some(ClaudeDesktopBindings {
            sonnet: " route-sonnet ".into(),
            opus: "route-opus".into(),
            haiku: " route-haiku ".into(),
            fable: String::new(),
            sonnet_name: " Kimi K2.7 ".into(),
            opus_name: "GLM-5.1".into(),
            haiku_name: " DeepSeek V4 ".into(),
            fable_name: String::new(),
        }),
    };
    normalize_routes(&mut routes);
    let cd = routes.claude_desktop.as_ref().unwrap();
    assert_eq!(cd.sonnet, "route-sonnet");
    assert_eq!(cd.haiku, "route-haiku");
    assert_eq!(cd.fable, "");
    assert_eq!(cd.sonnet_name, "Kimi K2.7");
    assert_eq!(cd.haiku_name, "DeepSeek V4");
}
