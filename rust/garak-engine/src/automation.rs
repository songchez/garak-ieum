//! Automation lanes (docs/AUTOMATION.md): engine.cpp `automationShape`, `evaluateAutomation`,
//! `automationValue`, which mirror automationShape() in src/core/automation.ts.

use crate::math;
use crate::plan::AutomationLane;

// The negated comparisons below keep the C++ NaN behaviour (`!(x > y)` is true for NaN).
/// Curved progress `t` of a segment (`curve` in -1..1; 0 is linear).
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn shape(t: f64, curve: f64) -> f64 {
    let x = math::std_clamp(t, 0.0, 1.0);
    if !(curve.abs() > 1e-6) {
        return x;
    }
    let k = math::std_clamp(curve, -1.0, 1.0) * 6.0;
    (math::exp(k * x) - 1.0) / (math::exp(k) - 1.0)
}

/// Normalized value at `frame`. `hint` caches the segment for monotonic calls (any value is valid).
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn evaluate(lane: &AutomationLane, frame: f64, hint: &mut usize) -> f64 {
    let p = &lane.points;
    let Some(first) = p.first() else { return 0.0 };
    if frame < first.frame {
        *hint = 0;
        return first.value;
    }
    let at = |i: usize| p.get(i).map_or(f64::INFINITY, |q| q.frame);
    let mut i = if *hint < p.len() { *hint } else { 0 };
    if at(i) > frame || (i + 1 < p.len() && at(i + 1) <= frame && (i + 2 >= p.len() || at(i + 2) <= frame)) {
        // std::upper_bound: the first point after `frame`, minus one (>= 0 since frame >= first).
        i = p.partition_point(|q| q.frame <= frame).saturating_sub(1);
    } else {
        while i + 1 < p.len() && at(i + 1) <= frame {
            i += 1;
        }
    }
    *hint = i;
    let Some(a) = p.get(i) else { return 0.0 };
    let b = match p.get(i + 1) {
        Some(b) if lane.options.is_empty() => b,
        _ => return a.value,
    };
    let span = b.frame - a.frame;
    if !(span > 1e-9) {
        return b.value;
    }
    math::mul_add(b.value - a.value, shape((frame - a.frame) / span, a.curve), a.value)
}

/// Normalized value -> the target's units (options, logarithmic or linear range).
pub fn value(lane: &AutomationLane, normalized: f64) -> f64 {
    let n = math::std_clamp(normalized, 0.0, 1.0);
    if !lane.options.is_empty() {
        let index = math::round(n * (lane.options.len() - 1) as f64) as usize;
        return lane.options.get(index).copied().unwrap_or(0.0);
    }
    if lane.logarithmic {
        lane.minimum * math::pow(lane.maximum / lane.minimum, n)
    } else {
        math::mul_add(n, lane.maximum - lane.minimum, lane.minimum)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{AutomationPoint, LaneTarget};
    use alloc::string::String;
    use alloc::vec;

    fn lane(points: &[(f64, f64, f64)]) -> AutomationLane {
        AutomationLane {
            target: LaneTarget::Volume,
            insert_id: String::new(),
            param: String::new(),
            return_id: String::new(),
            minimum: 0.0,
            maximum: 2.0,
            logarithmic: false,
            options: vec![],
            points: points
                .iter()
                .map(|&(frame, value, curve)| AutomationPoint { frame, value, curve })
                .collect(),
        }
    }

    #[test]
    fn segments_jumps_and_hints() {
        let l = lane(&[(10.0, 0.0, 0.0), (20.0, 1.0, 0.5), (20.0, 0.25, 0.0), (40.0, 0.75, 0.0)]);
        let mut hint = 0;
        assert_eq!(evaluate(&l, 0.0, &mut hint), 0.0);
        assert!((evaluate(&l, 15.0, &mut hint) - shape(0.5, 0.0)).abs() < 1e-15);
        assert_eq!(evaluate(&l, 20.0, &mut hint), 0.25); // jump: the later point wins
        assert!((evaluate(&l, 30.0, &mut hint) - 0.5).abs() < 1e-12);
        assert_eq!(evaluate(&l, 99.0, &mut hint), 0.75);
        let mut cold = 3;
        assert!((evaluate(&l, 12.0, &mut cold) - 0.2).abs() < 1e-12); // a stale hint searches
        assert_eq!(value(&l, 0.5), 1.0);
        assert!(shape(0.5, 1.0) < 0.5 && shape(0.5, -1.0) > 0.5);
    }
}
