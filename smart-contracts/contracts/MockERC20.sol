// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract MockERC20 {
    string public name = "TestToken";
    string public symbol = "TST";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address=>uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 v);
    event Approval(address indexed owner, address indexed spender, uint256 v);

    constructor(uint256 initialSupply) {
        totalSupply = initialSupply;
        balanceOf[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }
    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true;
    }
    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "bal");
        balanceOf[msg.sender] -= v; balanceOf[to] += v; emit Transfer(msg.sender, to, v); return true;
    }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        require(balanceOf[f] >= v, "bal");
        uint256 a = allowance[f][msg.sender]; require(a >= v, "allow"); allowance[f][msg.sender] = a - v;
        balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v); return true;
    }
}
