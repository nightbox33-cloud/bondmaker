pragma solidity 0.6.6;

import "./BondMakerInterface.sol";


interface BondMakerCollateralizedErc20Interface is BondMakerInterface {
    function issueNewBonds(uint256 bondGroupID, uint256 amount)
        external
        returns (uint256 bondAmount);
}
