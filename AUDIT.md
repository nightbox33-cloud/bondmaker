# Auditoría de seguridad — Lien BondMaker / GeneralizedDotc / BondPricer

**Fecha:** 31 de octubre de 2026
**Commit auditado:** `0130fcc4db3d309d7fc8c6d6a310307a62a4c405` (`audit report`, 25-ene-2021)
**Resultado:** 1 vulnerabilidad crítica confirmada con PoC ejecutable y parcheada. No se confirmó ningún otro drenaje de fondos de terceros que cumpla simultáneamente bug concreto + acceso permissionless + call graph real + PnL positivo a costa de terceros.

> Este informe distingue siempre entre **(a)** el código del commit auditado y **(b)** el árbol ya parcheado de esta rama. La verificación en vivo por RPC propio no se realizó: no había RPC ni direcciones desplegadas en el repositorio. Las direcciones y la pérdida del incidente externo se atribuyen expresamente a Verichains; no son una lectura propia de bytecode, storage ni balances actuales.

---

## 1. Resumen ejecutivo

### C-01 — `exchangeEquivalentBonds` validaba excepciones por conteo agregado y permitía mintear bonds sin quemar el payoff equivalente

| Pregunta | Veredicto |
|---|---|
| ¿Vulnerable en el código auditado? | **SÍ.** Confirmado ejecutando el código del commit auditado en una EVM local. |
| ¿Vulnerable tras el parche de esta rama? | **NO por esta vía.** Las tres construcciones de ataque revierten y los exchanges legítimos, incluidos grupos con bondIDs repetidos, siguen funcionando. |
| ¿Drena fondos de terceros? | **SÍ.** El colateral de todos los bond groups de un mismo `BondMaker` está agregado en un único balance; el supply minteado sin respaldo cobra de ese balance y deja insolvente la liquidación posterior de la víctima. |
| ¿Requiere rol privilegiado? | **No.** `registerNewBond`, `registerNewBondGroup` y `exchangeEquivalentBonds` son permissionless. |
| ¿Requiere que la víctima interactúe con el grupo del atacante? | **No.** Basta con que exista colateral de terceros en el mismo `BondMaker`. |
| ¿Hay una variante con depósito cero? | **SÍ.** En el PoC local el atacante no deposita ETH/USDC ni posee bonds antes de la llamada y extrae 9.9/10 ETH o 990/1000 USDC del maker. |

La causa raíz no es simplemente que un bond group pueda contener bondIDs repetidos: los grupos duplicados son una funcionalidad legítima ya cubierta por los tests históricos. El bug es que el código original comprobaba únicamente que un contador agregado de coincidencias con `exceptionBonds` volviera a cero. No comprobaba, para cada bondID de excepción y con su multiplicidad exacta, que ese bondID estuviera presente en ambos grupos. Repetir un bondID podía compensar numéricamente la ausencia de otro, de modo que el conjunto quemado y el conjunto minteado dejaban de ser equivalentes.

El parche conserva la semántica de multiconjunto de los bond groups y resta las excepciones también como multiconjunto: para cada bondID exceptuado se omiten exactamente el mismo número de ocurrencias al quemar y al mintear, y se exige que ambos grupos contengan al menos ese número de ocurrencias. Bajo esa regla, si el payoff total de cada grupo es la identidad, el payoff residual quemado y el payoff residual minteado son exactamente el mismo.

---

## 2. Alcance y método

### 2.1 Código revisado

Se revisó todo el árbol Solidity del repositorio en el commit indicado:

- `contracts/bondMaker/`: `BondMaker`, variantes colateralizadas con ETH, ERC20 genérico y USDC, e interfaces.
- `contracts/bondToken/`: `BondToken`, variantes ETH/ERC20 y `BondTokenFactory`.
- `contracts/generalizedDotc/`: `GeneralizedDotc`, `BondExchange`, `BondVsErc20Exchange`, `BondVsEthExchange`, `BondVsBondExchange` y contratos `Only*` de test.
- `contracts/bondPricer/`: `GeneralizedPricing`, `CustomGeneralizedPricing`, `BondPricer`, `SbtPricerWithStableBorder` y `DetectBondShape`.
- `contracts/oracle/`: interfaces y adaptadores incluidos en el repo. Los oráculos externos reales referenciados por las migraciones no forman parte del código fuente disponible.
- `contracts/helper/`, `contracts/math/`, `contracts/token/`, `contracts/util/`, `contracts/bondTokenName/` y contratos `*.test.sol`.
- Migraciones Truffle y tests TypeScript usados como evidencia de wiring y semántica pretendida. El `dump.json` de despliegue está en `.gitignore` y no está presente.

No hay proxies, `delegatecall`, clones, ERC4626, flash loans ni funciones `recover` en el código in-scope. El único envío de ETH pasa por `TransferETH`.

### 2.2 Inventario de custodia

Los puntos que realmente custodian valor de terceros son:

1. **`BondMakerCollateralizedEth`**: mantiene agregado el ETH depositado para todos los bond groups.
2. **`BondMakerCollateralizedErc20` / `EthBondMakerCollateralizedUsdc`**: mantienen agregado el token de colateral transferido vía allowance.
3. **Contratos `BondToken` tras `liquidateBond`**: reciben la porción asignada a su bondID y pagan a quien queme el token ya expirado según `_rate`.
4. **`BondVsEthExchange` dentro de `GeneralizedDotc`**: custodia los depósitos ETH de los sellers.
5. En los exchanges contra ERC20 o contra bonds, los fondos se mueven directamente entre seller y buyer mediante `transferFrom`; el exchange no mantiene un inventario ERC20 propio equivalente al del maker.

La consecuencia de seguridad más importante es la primera: un exceso de supply de cualquier bond registrado compite por el mismo balance agregado del maker. No existe segregación de colateral por bond group.

### 2.3 Criterio de confirmación

Un hallazgo solo se reporta como crítico si cumple las cuatro condiciones siguientes:

1. Hay un bug concreto en el código auditado.
2. El ataque es permissionless o puede dispararse con transacciones normales.
3. El call graph es real con el wiring, decimales, cardinalidades y validaciones del código.
4. Existe una traza `X → Y > X` ejecutable, con beneficio neto extraído de fondos ajenos después de cerrar la posición.

Las hipótesis que no cumplen las cuatro condiciones aparecen únicamente en la sección de descartes, con el hecho que las invalida.

### 2.4 Herramientas de verificación usadas

La suite histórica Truffle 5.1 / ganache-cli 6.4.2 no es ejecutable de forma fiable con el Node 22 disponible. En su lugar se construyó un harness autónomo y reproducible en `audit/poc/` con:

- `solc` 0.6.6 exacto;
- `@openzeppelin/contracts` 3.0.1;
- `ganache` 7.9.2;
- `ethers` 5.7.2.

Con ese harness:

- se compilaron los contratos necesarios para los PoC;
- se compilaron además los **59 archivos `.sol` / 70 contratos** del repo tras el parche;
- se ejecutaron tres PoC contra el commit vulnerable;
- se ejecutó una regresión EVM contra el árbol parcheado;
- se ejecutó un escaneo numérico del pricer: `tested=61094 reverts=23878 flags=0`.

---

## 3. Hallazgo crítico C-01

### 3.1 Ubicación

- `contracts/bondMaker/BondMaker.sol::exchangeEquivalentBonds` en el commit auditado.
- La lógica vulnerable está en el contrato abstracto `BondMaker`, por lo que afecta a las variantes ETH, ERC20 genérica y USDC que heredan de él.

### 3.2 Semántica correcta que el código debía preservar

Un bond group válido es un multiconjunto de bondIDs cuyos payoffs suman la identidad:

```text
suma_{i in G_in}  f_i(x) = x
suma_{j in G_out} f_j(x) = x
```

`registerNewBondGroup` fuerza esa identidad en los breakpoints relevantes y las funciones son lineales a trozos. Los bondIDs pueden repetirse dentro de un grupo; cada ocurrencia aporta el payoff una vez. Los tests históricos usan explícitamente grupos como `[S, I, I]` y `[S, I, J, J]`.

`exchangeEquivalentBonds(G_in, G_out, amount, exceptionBonds)` debe quemar `amount` de cada ocurrencia no exceptuada de `G_in` y mintear `amount` de cada ocurrencia no exceptuada de `G_out`. Para que la operación conserve valor, las excepciones restadas a ambos lados tienen que ser el mismo multiconjunto `E`:

```text
payoff(G_in - E) = x - payoff(E) = payoff(G_out - E)
```

### 3.3 Bug en el commit auditado

El código original usaba un único contador agregado:

```solidity
// Pseudocódigo fiel al commit auditado
uint256 exceptionCount;

for (bondID in inputIDs) {
    for (exceptionID in exceptionBonds) {
        if (exceptionID == bondID) exceptionCount++;
    }
    if (bondID no coincide con ninguna excepción) burn(bondID);
}
require(exceptionCount == exceptionBonds.length);

for (bondID in outputIDs) {
    for (exceptionID in exceptionBonds) {
        if (exceptionID == bondID) exceptionCount--;
    }
    if (bondID no coincide con ninguna excepción) mint(bondID);
}
require(exceptionCount == 0);
```

Ese contador cuenta ocurrencias totales que coinciden con cualquier excepción. No identifica qué excepción concreta fue satisfecha en cada grupo. Si un bondID repetido coincide dos veces, puede compensar la ausencia total de otro bondID de excepción. Además, la decisión burn/mint era por pertenencia booleana al conjunto de excepciones, no por multiplicidad de ocurrencia.

### 3.4 Construcción fondeada: 1 ETH → 1.9660678603 ETH brutos

PoC: `audit/poc/poc-funded-eth.js`

Payoffs usados, con breakpoints 100/200/300 y extrapolación lineal de la cola:

- `2·f_B + f_T = x`, con `f_B = (40, 95, 145)` y `f_T = (20, 10, 10)`.
- `f_R + 2·f_C = x`, con `f_R = (100, 198, 298)` y `f_C = (0, 1, 1)`.

Grupos y llamada:

```text
G_in  = [B, B, T]
G_out = [R, C, C]
exceptionBonds = [B, C]
```

En el lado input, `B` coincide dos veces y `C` cero: el contador llega a 2, igual que `exceptionBonds.length`. En el lado output, `C` coincide dos veces y `B` cero: el contador vuelve a 0. Las dos `require` pasan aunque `C` no está en `G_in` y `B` no está en `G_out`.

Efecto real:

- quema únicamente `T`;
- conserva las dos posiciones valiosas `B`;
- mintea `R`, casi la identidad, sin entregar su equivalente.

Resultado ejecutado contra el commit vulnerable, con otra víctima que había depositado 10 ETH en el mismo maker y precio de liquidación 400:

```text
Attacker deposited : 1.000000 ETH
Attacker net PnL (gas added back): 0.9660678603 ETH
Attacker gross received from burns: ~ 1.9660678603 ETH
Victim liquidation REVERTED
SUCCESS: permissionless drain
```

El beneficio sale del colateral agregado aportado por la víctima. La víctima no puede completar después su liquidación porque el maker ya no tiene balance suficiente para pagar todos los supplies.

### 3.5 Construcción con depósito cero en ETH: 0 → 9.9 ETH

PoC: `audit/poc/poc-zero-input-eth.js`

Payoffs proporcionales:

```text
f_B = 0.49x
f_T = 0.02x
f_C = 0.24x
f_R = 0.25x

G_in  = [B, B, T]          // 0.49 + 0.49 + 0.02 = 1
G_out = [R, B, T, C]       // 0.25 + 0.49 + 0.02 + 0.24 = 1
exceptionBonds = [B, T, C]
```

En el input hay tres coincidencias agregadas (`B` dos veces y `T` una; `C` ninguna), por lo que no se quema nada. En el output, `B`, `T` y `C` descuentan el contador a cero y solo `R` se mintea. El atacante parte sin depósito y sin ningún bond.

Con `amount = 3,960,000,000`, dimensionado para reclamar 9.9 ETH de un maker con 10 ETH de la víctima:

```text
Attacker deposited: 0 ETH | Attacker net PnL (gas added back): 9.9 ETH
BondMaker balance left: 0.0802 ETH (victim deposited 10)
Victim liquidateBond REVERTED (insolvent BondMaker).
SUCCESS: zero-input drain of 9.9 ETH
```

### 3.6 Construcción con depósito cero en USDC: 0 → 990 USDC

PoC: `audit/poc/poc-zero-input-usdc.js`

La misma construcción sobre `EthBondMakerCollateralizedUsdc`, heredero del mismo `BondMaker` abstracto, extrae 990 de los 1000 USDC depositados por la víctima sin depósito del atacante:

```text
Attacker USDC (deposited 0): 990000000 (=990 USDC)
Maker USDC left: 8020000 (=8.02 USDC)
Victim liquidateBond REVERTED.
SUCCESS on USDC maker
```

### 3.7 Call graph y monetización

La ruta permissionless completa es:

```text
registerNewBond(...)                         // registra fnMaps y despliega BondTokens vía factory
registerNewBondGroup(...)                    // registra G_in/G_out, ambos suman la identidad
[opcional] issueNewBonds(...)                // solo en la variante fondeada
exchangeEquivalentBonds(G_in, G_out, A, E)   // quema de menos y/o mintea sin respaldo
liquidateBond(G_out, 0)                      // tras maturity, asigna colateral al BondToken
BondToken.burnAll()                          // cobra del balance agregado del maker
```

Alternativamente, antes de maturity, un bond minteado sin respaldo puede venderse a un LP de `GeneralizedDotc`, porque el pricer valora el payoff registrado y no comprueba qué parte del supply fue creada contra colateral. No hace falta esa ruta para probar C-01: los PoC anteriores cierran el beneficio directamente contra el colateral del maker.

### 3.8 Corroboración externa, no verificación live propia

Verichains publicó un post-mortem de un exploit real del 24-jul-2026 con la misma causa raíz descrita aquí: conteo agregado de excepciones en `exchangeEquivalentBonds`, mint sin burn equivalente y venta posterior a un pool GeneralizedDotc. Según esa fuente externa, no verificada por RPC en esta auditoría:

- pérdida aproximada: **542,144.63 USDC**;
- `BondMakerCollateralizedEth`: `0x843225CF6e663e4454732D6B551A737Ac7b47de0`;
- dirección adicional listada como vulnerable: `0xDA6FC5625E617bB92F5359921D43321cEbC6BEf0`;
- pool GeneralizedDotc afectado: `0x656e5e976d523a427f05B0c212A22A89ccD9eF18`;
- EOA atacante: `0x0D7d9023531aD1A88414E216Ee2715F63561808a`;
- contrato atacante: `0xe74d17c1bE3721E65e0af286D47B3BA58B08062e`;
- LP víctima: `0xA961684a3a654fb2cCA8F8991226C0CEfc514d80`;
- transacción: `0xb96d572b557a12f5ef193e88cca86123a6ae1b6e98b0eeee265870c85848e0e7`.

Fuente: <https://blog.verichains.io/p/lien-finance-hack-analysis>

No se afirma el TVL, el saldo ni el estado actual de esas direcciones.

---

## 4. Parche aplicado

### 4.1 Corrección de C-01 en `BondMaker.sol`

El parche elimina el contador agregado y aplica semántica exacta de multiconjunto:

1. Para cada bondID distinto `b` en `exceptionBonds`, sea `e_b` su multiplicidad en la lista de excepciones.
2. Se exige `count(G_in, b) >= e_b` y `count(G_out, b) >= e_b`.
3. Al recorrer cada grupo, se omiten únicamente las primeras `e_b` ocurrencias de `b`.
4. Todas las demás ocurrencias se queman o se mintean, una por una.

Prueba de conservación: si `m_b` y `n_b` son las multiplicidades de `b` en input y output, se quema `m_b - e_b` y se mintea `n_b - e_b`. Sumando sobre todos los bondIDs:

```text
payoff quemado  = x - suma_b e_b·f_b(x)
payoff minteado = x - suma_b e_b·f_b(x)
```

Por tanto, el exchange residual es equivalente para todo `x`, incluidos grupos legítimos con duplicados.

No se prohibió registrar grupos con bondIDs repetidos. Esa prohibición habría roto casos legítimos ya presentes en `test/bondMaker/testCases.ts` y no es necesaria una vez que las excepciones se cuentan por bondID y multiplicidad.

### 4.2 Cambios de compatibilidad de interfaces y build

Estos cambios no son hallazgos adicionales ni modifican la economía del protocolo; alinean el fuente con las firmas y tipos que el propio código ya usa:

- `BondMakerCollateralizedErc20Interface.issueNewBonds` pasa de la firma inexistente `(uint256)` a la implementada `(uint256, uint256)`.
- `BondMakerCollateralizedErc20` y `BondMakerCollateralizedEth` heredan ahora sus interfaces especializadas y marcan `issueNewBonds` como `override`, de modo que futuras divergencias de firma fallen en compilación.
- `GeneralizedPricing` implementa formalmente `BondPricerInterface`; el selector externo no cambia.
- `CustomGeneralizedPricing` almacena el pricer subyacente como `BondPricerInterface`, no como el contrato concreto `GeneralizedPricing`.
- `PriceInverseOracle.test.sol` importa `./oracle.test.sol` con la capitalización real del archivo, necesaria en sistemas de archivos sensibles a mayúsculas.

### 4.3 Qué no se cambió y por qué

No se añadió un `BondPricerRegistry` ni una allowlist de pricers. Ese cambio no es necesario para cerrar C-01: tras el parche ya no puede crearse supply sin quemar el payoff equivalente. Además, la ausencia de validación del pricer de un pool ya era un punto conocido y aceptado en la auditoría CertiK incluida en el repo (BVB-04, VEE-03 y BVE-02), y en el diseño actual los parámetros del pool los elige su seller. Sustituir ese modelo por un registro gobernado sería una decisión de producto y de confianza, no la corrección mínima del drenaje probado.

Tampoco se modificaron migraciones: el wiring existente ya pasa `SbtPricerWithStableBorder` como pricer del bond de pago del usuario y `BondPricer` como pricer del bond objetivo en `createVsBondPool`, y el detector de forma ya es un inmutable cableado en `GeneralizedDotc`.

---

## 5. Regresión ejecutada sobre el árbol parcheado

Archivo: `audit/poc/regression.js`

Resultado:

```text
[1] historical attacks revert
  PASS zero-input attack reverted
  PASS zero-input R balance remains zero = 0
  PASS funded attack reverted
  PASS funded attack B balance unchanged = 199600798
  PASS funded attack T balance unchanged = 99800399
  PASS funded attack R balance remains zero = 0

[2] legitimate distinct-bond exchange succeeds
  PASS distinct X kept = 99800399
  PASS distinct Y burned = 0
  PASS distinct Z minted = 99800399
  PASS distinct W minted = 99800399

[3] legitimate duplicate-bond exchange succeeds
  PASS duplicate issue mints I twice = 199600798
  PASS duplicate S kept = 99800399
  PASS duplicate I net burned once = 99800399
  PASS duplicate J minted twice = 199600798

[4] repeated exceptions are subtracted by exact multiplicity
  PASS multiplicity S kept = 199600798
  PASS multiplicity I net burned once = 199600798
  PASS multiplicity J minted twice more = 399201596
  PASS exception multiplicity exceeding output group reverted

All BondMaker exchange regression checks passed.
```

Validaciones adicionales ejecutadas:

```text
compiled 59 source files / 70 contracts with solc 0.6.6+commit.6c089d02.Emscripten.clang
tested=61094 reverts=23878 flags=0
```

Los scripts de exploit originales, ejecutados contra el árbol parcheado, terminan con error en la transacción de `exchangeEquivalentBonds`, como es esperado. La regresión anterior es la comprobación autoritativa del comportamiento parcheado porque captura el revert y verifica balances.

---

## 6. Hipótesis examinadas y descartadas como críticas

La tabla siguiente no contiene hallazgos. Contiene el hecho concreto que impide convertir cada hipótesis en un drenaje probado de terceros bajo el criterio de esta auditoría.

| Hipótesis | Hecho que mata el claim |
|---|---|
| Sobreprecio extraíble en `GeneralizedPricing` / `DetectBondShape` dentro de la ventana aceptada por `BondPricer` | El escaneo numérico reproducible en `audit/poc/scan_pricer.py` evaluó 61,094 casos sin producir flags de fuera de rango ni de sobre/infraprecio según los umbrales codificados en el script. No se encontró una traza completa con beneficio neto tras spread. |
| Duplicados dentro de un grupo por sí solos en issue/reverse/liquidate | En issue y reverse cada ocurrencia se mintea/quema una vez contra la misma cantidad; en liquidación, la segunda llamada sobre el mismo BondToken no vuelve a asignar colateral porque `expire` ya no devuelve el flag de primera expiración. El problema probado estaba solo en la validación de excepciones del exchange. |
| Bug histórico de bond group vacío | Es el bug de 2020 ya documentado en el README. El código auditado llama `_assertNonEmptyBondGroup` en issue, reverse, exchange y liquidate. No se reporta como hallazgo nuevo. |
| Crear un BondToken falso con la factory permissionless y cobrar colateral | `BondTokenFactory.createBondToken` no registra el token en `_bonds`. Las rutas de dinero del maker y del exchange exigen que el bondID resuelva a un contrato registrado; un token creado fuera del registro no adquiere claim sobre el colateral. |
| Pricer u oracle arbitrario en un pool GDOTC | Es un punto conocido y aceptado por el equipo en la auditoría CertiK del repo. Los parámetros los fija el seller creador del pool y solo ese seller puede actualizarlos; no se demostró una ruta que fuerce a un inventario protocolario ajeno a aceptar un pricer impuesto por un tercero. |
| Ciclos de redondeo issue → reverse/liquidate | La fee de emisión redondea hacia arriba a favor del protocolo y los pagos de reverse/liquidación redondean hacia abajo; repetir el ciclo pierde fee/dust en lugar de crear colateral. |
| Reentrada vía callbacks de token o ETH en las rutas de dinero | Los tokens in-scope son ERC20 de OpenZeppelin sin hooks de receptor, y las rutas revisadas actualizan/queman antes de los envíos relevantes o revierten atómicamente si el envío falla. No se encontró una segunda entrada que produzca `Y > X`. |

No se elevan a hallazgo los puntos ya conocidos o aceptados en la auditoría CertiK incluida en el repositorio cuando no aportan un exploit nuevo que cumpla las cuatro condiciones.

---

## 7. Reproducción

### 7.1 Verificar el árbol parcheado

Desde la raíz del repositorio:

```bash
cd audit/poc
npm install
npm run compile
npm run regression
npm run compile:all
npm run scan:pricer
```

Resultados esperados:

- `npm run regression` termina con `All BondMaker exchange regression checks passed.`
- `npm run compile:all` compila 59 archivos fuente y 70 contratos con solc 0.6.6.
- `npm run scan:pricer` imprime `tested=61094 reverts=23878 flags=0`.

### 7.2 Reproducir la vulnerabilidad en el commit auditado

El harness no existía en el commit vulnerable. Para ejecutar los PoC contra ese código sin tocar la rama parcheada:

```bash
# Desde la raíz de la rama parcheada:
git worktree add --detach /tmp/bondmaker-vuln 0130fcc4db3d309d7fc8c6d6a310307a62a4c405
mkdir -p /tmp/bondmaker-vuln/audit
cp -R audit/poc /tmp/bondmaker-vuln/audit/poc

cd /tmp/bondmaker-vuln/audit/poc
rm -rf node_modules artifacts.json package-lock.json
npm install
npm run compile
npm run poc:funded-eth
npm run poc:zero-input-eth
npm run poc:zero-input-usdc
```

Los tres comandos de PoC deben terminar en éxito contra el commit vulnerable y con revert en `exchangeEquivalentBonds` contra el árbol parcheado.

Limpieza opcional del worktree temporal:

```bash
# Desde la raíz de la rama parcheada:
git worktree remove --force /tmp/bondmaker-vuln
```

### 7.3 Archivos de evidencia incluidos

- `audit/poc/poc-funded-eth.js` — drenaje fondeado 1 ETH → 1.9660678603 ETH brutos.
- `audit/poc/poc-zero-input-eth.js` — drenaje sin depósito 0 → 9.9 ETH.
- `audit/poc/poc-zero-input-usdc.js` — drenaje sin depósito 0 → 990 USDC.
- `audit/poc/regression.js` — ataques bloqueados y exchanges legítimos preservados.
- `audit/poc/compile.js` — compilación de los contratos de los PoC con solc 0.6.6.
- `audit/poc/compile-all.js` — compilación de los 59 archivos Solidity del repo.
- `audit/poc/scan_pricer.py` — escaneo numérico del pricer.
- `audit/poc/package.json` — versiones exactas del harness.

---

## 8. Limitaciones

1. **Sin verificación live propia.** No se leyó bytecode, storage, TVL ni balances actuales por RPC. Todas las direcciones e importes del incidente de 2026 se atribuyen a Verichains.
2. **Commit y árbol local.** La confirmación técnica propia es sobre el fuente del commit auditado ejecutado en una EVM local y sobre el árbol parcheado de esta rama.
3. **Suite Truffle histórica no ejecutada.** La toolchain original es incompatible con el Node 22 disponible. Se sustituyó por compilación completa con solc-js 0.6.6 y tests EVM dirigidos en Ganache; los tests históricos se usaron como especificación de semántica, en particular para no romper grupos legítimos con duplicados.
4. **Oráculos externos fuera del fuente.** Las migraciones pueden recibir direcciones de oráculos cuyo código no está en este repositorio; esos contratos externos no fueron auditados aquí.

---

## 9. Archivos modificados por el parche

- `contracts/bondMaker/BondMaker.sol` — corrección de C-01.
- `contracts/bondMaker/BondMakerCollateralizedErc20Interface.sol` — firma `issueNewBonds(uint256,uint256)`.
- `contracts/bondMaker/BondMakerCollateralizedErc20.sol` — herencia de la interfaz especializada.
- `contracts/bondMaker/BondMakerCollateralizedEth.sol` — herencia de la interfaz especializada.
- `contracts/bondPricer/GeneralizedPricing.sol` — implementación formal de `BondPricerInterface`.
- `contracts/bondPricer/CustomGeneralizedPricing.sol` — pricer subyacente tipado por interfaz.
- `contracts/oracle/PriceInverseOracle.test.sol` — capitalización correcta del import de test.
- `audit/poc/*` — PoC, regresión y harness de compilación.
- `AUDIT.md` — este informe.
