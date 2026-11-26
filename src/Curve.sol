// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Checks on BabyJubJub points
/// @notice The auditor keys live on the curve `a*x^2 + y^2 = 1 + d*x^2*y^2` over the circuit
///         field. The curve has cofactor 8, and the circuit's scalar multiplication assumes a
///         point of the prime-order subgroup. With the identity or the point of order 2 the
///         auditor record would be readable by anyone, so the pool checks keys with this
///         library before it stores them.
library Curve {
    uint256 internal constant FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant A = 168700;
    uint256 internal constant D = 168696;
    /// @dev Order of the prime-order subgroup. The whole curve has 8 times this many points.
    uint256 internal constant SUBGROUP_ORDER =
        2736030358979909402780800718157159386076813972158567259200215660948447373041;
    /// @dev Bit length of SUBGROUP_ORDER.
    uint256 internal constant SUBGROUP_BITS = 251;

    /// @dev A point in projective coordinates: (x / z, y / z). The identity is (0, 1, 1).
    struct Projective {
        uint256 x;
        uint256 y;
        uint256 z;
    }

    /// @notice Does the pair satisfy the curve equation with both coordinates in the field?
    /// @dev The identity (0, 1) and the order-2 point (0, -1) pass this check.
    function isOnCurve(uint256 x, uint256 y) internal pure returns (bool) {
        if (x >= FIELD || y >= FIELD) return false;
        uint256 x2 = mulmod(x, x, FIELD);
        uint256 y2 = mulmod(y, y, FIELD);
        return addmod(mulmod(A, x2, FIELD), y2, FIELD) == addmod(1, mulmod(D, mulmod(x2, y2, FIELD), FIELD), FIELD);
    }

    /// @notice Is the point in the prime-order subgroup? True for the identity as well.
    /// @dev A point is in the subgroup exactly when SUBGROUP_ORDER * P is the identity (0, 1).
    ///      In projective coordinates that is x = 0 and y = z. Checking x alone is not enough:
    ///      the order-2 point (0, -1) has x = 0 too and, the order being odd, keeps it.
    function isInSubgroup(uint256 x, uint256 y) internal pure returns (bool) {
        Projective memory acc = Projective(0, 1, 1);
        unchecked {
            for (uint256 bit = SUBGROUP_BITS; bit > 0; --bit) {
                _double(acc);
                if ((SUBGROUP_ORDER >> (bit - 1)) & 1 == 1) _addMixed(acc, x, y);
            }
        }
        return acc.x == 0 && acc.y == acc.z;
    }

    /// @notice Can this point be an auditor key? A non-identity point of the prime-order subgroup.
    function isAuditorKey(uint256 x, uint256 y) internal pure returns (bool) {
        return x != 0 && isOnCurve(x, y) && isInSubgroup(x, y);
    }

    /// @dev Doubles `p` in place, from x3 = 2xy / (a*x^2 + y^2) and y3 = (y^2 - a*x^2) / (2 - a*x^2 - y^2).
    function _double(Projective memory p) private pure {
        uint256 ax2 = mulmod(A, mulmod(p.x, p.x, FIELD), FIELD);
        uint256 y2 = mulmod(p.y, p.y, FIELD);
        uint256 z2 = mulmod(p.z, p.z, FIELD);
        uint256 d1 = addmod(ax2, y2, FIELD);
        uint256 d2 = addmod(addmod(z2, z2, FIELD), FIELD - d1, FIELD);
        p.x = mulmod(mulmod(addmod(p.x, p.x, FIELD), p.y, FIELD), d2, FIELD);
        p.y = mulmod(addmod(y2, FIELD - ax2, FIELD), d1, FIELD);
        p.z = mulmod(d1, d2, FIELD);
    }

    /// @dev Adds the affine point (x2, y2) to `p` in place, from
    ///      x3 = (x1*y2 + y1*x2) / (1 + d*x1*x2*y1*y2) and y3 = (y1*y2 - a*x1*x2) / (1 - d*x1*x2*y1*y2).
    function _addMixed(Projective memory p, uint256 x2, uint256 y2) private pure {
        uint256 xy = mulmod(p.x, y2, FIELD); // X1 * y2
        uint256 yx = mulmod(p.y, x2, FIELD); // Y1 * x2
        uint256 xx = mulmod(p.x, x2, FIELD); // X1 * x2
        uint256 yy = mulmod(p.y, y2, FIELD); // Y1 * y2
        uint256 e = mulmod(D, mulmod(xx, yy, FIELD), FIELD);
        uint256 z2 = mulmod(p.z, p.z, FIELD);
        uint256 d1 = addmod(z2, e, FIELD);
        uint256 d2 = addmod(z2, FIELD - e, FIELD);
        uint256 x3 = mulmod(addmod(xy, yx, FIELD), mulmod(d2, p.z, FIELD), FIELD);
        p.y = mulmod(addmod(yy, FIELD - mulmod(A, xx, FIELD), FIELD), mulmod(d1, p.z, FIELD), FIELD);
        p.z = mulmod(d1, d2, FIELD);
        p.x = x3;
    }
}
