// GENERATED FILE. Do not edit. Made by scripts/setup-proving-key.mjs from build/keys/transact.zkey
// (sha256 ba3099245c04bcc3719ee68ee27d61ebd293e358591560b6cbabb6ad974eede6). The public record of the key is ceremony/testnet.json.
// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract Groth16Verifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 5042886236985050616742165802913363798182111878752684074176141911336563473198;
    uint256 constant deltax2 = 19270942627989755718014980019435534117293610264901499275298254820062601155279;
    uint256 constant deltay1 = 5335799673263552341996409110649049014348654134923111539208006340410178523217;
    uint256 constant deltay2 = 18558507894949324559375437184798909193332210232173626781971842304338833025121;

    
    uint256 constant IC0x = 8639386423216278908061948667476080617884231085221859794711144877898327931782;
    uint256 constant IC0y = 4458248950446576629865866197932638005177484939556203760425224268740290803648;
    
    uint256 constant IC1x = 7200347289429330566334932945355006017527602103843245639484451640496182839342;
    uint256 constant IC1y = 20054209819291373049877551041700012018475709927706437036029358246585434579876;
    
    uint256 constant IC2x = 3153962578779178543793686627645221886135882213718145723473541221859079117158;
    uint256 constant IC2y = 4095937441058141624855969894378440892612973450660136743260345797395786089673;
    
    uint256 constant IC3x = 14993782816395641467516657059829312599511068334255929337415235129896488488382;
    uint256 constant IC3y = 1096618859498755545930927567416350293144769869891522876541531058605591947370;
    
    uint256 constant IC4x = 1732547644513930962327090717248397714361309743999741097480538693738836979956;
    uint256 constant IC4y = 3303227682806779956811317692988802269796844586838078533838732342668131461950;
    
    uint256 constant IC5x = 13497022975042014632365697599830781892848339729430646853591556294725670182038;
    uint256 constant IC5y = 2558157737830554998730356210925776060434826539628033117382902940913765477833;
    
    uint256 constant IC6x = 6760912192783336398606687174043436581197875247308950870680926147685655503525;
    uint256 constant IC6y = 10552060866974561314961665069819648854744969331202247926842134289925976065946;
    
    uint256 constant IC7x = 10222909203760286945741096996550763897292604477103070655010231060924850100563;
    uint256 constant IC7y = 8681296661852484295634748568755818005092669148360965101408732859950570268992;
    
    uint256 constant IC8x = 6676739297604771390573650957334952875074219994684085361251398940627997086226;
    uint256 constant IC8y = 1590219140904683040871175089671877035695737297179470397265996882161822695696;
    
    uint256 constant IC9x = 4322577660750566814133798711278126650033754020845830599656203218764467616303;
    uint256 constant IC9y = 10202110296945528582417569654039241792727068283550022249055722617055379197473;
    
    uint256 constant IC10x = 19124197960380037675744256792918327772748572427762106654289914624138549648812;
    uint256 constant IC10y = 3768127536772065685446472681070291922439694566747963084697512820876725929357;
    
    uint256 constant IC11x = 13489299235518480062538575114929562075069971014572547998046849040751402581974;
    uint256 constant IC11y = 255321304609662212274929902693314468801816469224555094977446332184126847826;
    
    uint256 constant IC12x = 15184027610352678726287001682818089735831513964778842178129560374332756879831;
    uint256 constant IC12y = 15590786380057856213166569733860776644643878655237878764260486070752576787187;
    
    uint256 constant IC13x = 19293332344213238402467753098875191771089535934010541128895464279578485968533;
    uint256 constant IC13y = 13297598825432187953650322005420035807352121726585976146355868943001923225795;
    
    uint256 constant IC14x = 2096682625736607930327220508040427346886324722329796836946860875348857433668;
    uint256 constant IC14y = 16055640492350408259952312962385713348656784832149747010246152703983412663017;
    
    uint256 constant IC15x = 4434627922325733076995280045103743771194438042053573219417613310013615103845;
    uint256 constant IC15y = 16791174751398721112701167770830488831015376528748546563538274428839797502516;
    
    uint256 constant IC16x = 13037376593500247300805846918598475002824669924232957001298821237562408016205;
    uint256 constant IC16y = 8605144827318414585276917001260833054510685331889453518468072630987276219658;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[16] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
