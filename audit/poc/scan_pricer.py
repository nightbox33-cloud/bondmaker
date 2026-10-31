import math

M = 1 << 256
H = 1 << 255
def i256(x):
    x %= M
    return x - M if x >= H else x
def add(a,b): return i256(a+b)
def sub(a,b): return i256(a-b)
def mul(a,b): return i256(a*b)
def pw(a,n):
    r=1
    for _ in range(n): r=i256(r*a)
    return r
def sdiv(a,b):
    if b==0: raise ZeroDivisionError
    # solidity int division truncates toward zero; -2^255/-1 wraps (ignore edge)
    q = abs(a)//abs(b)
    if (a<0) != (b<0): q=-q
    return i256(q)

SQRT_2PI_E8=250662827; E_E8=271828182; INV_E_E8=36787944
p=23164190; b1=31938153; b2=-35656378; b3=178147793; b4=-182125597; b5=133027442
SQRT_YEAR_E8=561569229926

def _sqrt(x):
    assert x>=0
    z=(x+1)//2; y=x
    while z<y:
        y=z; z=(x//z+z)//2
    return y

def _logTaylor1(v):
    out = v
    out = sub(out, sdiv(pw(v,2), mul(2,10**4)))
    out = add(out, sdiv(pw(v,3), mul(3,10**8)))
    out = sub(out, sdiv(pw(v,4), mul(4,10**12)))
    out = add(out, sdiv(pw(v,5), mul(5,10**16)))
    out = sub(out, sdiv(pw(v,6), mul(6,10**20)))
    out = add(out, sdiv(pw(v,7), mul(7,10**24)))
    out = sub(out, sdiv(pw(v,8), mul(8,10**28)))
    return out

def _logTaylor(inputE4):
    if inputE4<=1: raise ValueError("log input")
    inputE8 = mul(inputE4, 10**4)
    out=0
    guard=0
    while inputE8 < INV_E_E8:
        inputE8 = sdiv(mul(inputE8, E_E8), 10**8); out-=10**4; guard+=1
        if guard>10000: raise ValueError("loop")
    while inputE8 > 10**8:
        inputE8 = sdiv(mul(inputE8, INV_E_E8), 10**8); out+=10**4; guard+=1
        if guard>10000: raise ValueError("loop")
    return add(out, _logTaylor1(sub(sdiv(inputE8,10**4),10**4)))

def _calcPnorm(inputE4):
    if not (inputE4 < 440*10**4 and inputE4 > -440*10**4): raise ValueError("pnorm range")
    _in = inputE4 if inputE4>0 else mul(inputE4,-1)
    t = sdiv(10**16, add(10**8, sdiv(mul(p,_in),10**4)))
    X2 = sdiv(mul(inputE4,inputE4),2)
    exp2X2 = 10**8
    exp2X2 = add(exp2X2, X2)
    exp2X2 = add(exp2X2, sdiv(pw(X2,2), mul(2,10**8)))
    exp2X2 = add(exp2X2, sdiv(pw(X2,3), mul(6,10**16)))
    exp2X2 = add(exp2X2, sdiv(pw(X2,4), mul(24,10**24)))
    exp2X2 = add(exp2X2, sdiv(pw(X2,5), mul(120,10**32)))
    exp2X2 = add(exp2X2, sdiv(pw(X2,6), mul(720,10**40)))
    Z = sdiv(sdiv(10**24, exp2X2), SQRT_2PI_E8)
    y = sdiv(mul(b5,t),10**8)
    y = sdiv(mul(add(y,b4),t),10**8)
    y = sdiv(mul(add(y,b3),t),10**8)
    y = sdiv(mul(add(y,b2),t),10**8)
    y = sub(10**8, sdiv(mul(Z, mul(add(y,b1),t)), 10**16))
    return y if inputE4>0 else sub(10**8, y)

def calcCall(S,K,volE8,T):
    assert 0<S<10**13 and 0<volE8<10*10**8 and 0<T<31536000 and 0<K<10**13
    spotPerStrikeE4 = sdiv(mul(S,10**4),K)
    sqrtT=_sqrt(T)
    sigE8 = sdiv(mul(mul(volE8,sqrtT),10**8), SQRT_YEAR_E8)
    logSig = _logTaylor(spotPerStrikeE4)
    d1E4 = add(sdiv(mul(logSig,10**8), sigE8), sdiv(sigE8, mul(2,10**4)))
    nd1=_calcPnorm(d1E4)
    d2E4=sub(d1E4, sdiv(sigE8,10**4))
    nd2=_calcPnorm(d2E4)
    lowest = S-K if S>K else 0
    lp = sdiv(sub(mul(S,nd1),mul(K,nd2)),10**8)
    if lp<lowest: lp=lowest
    return lp, nd1, nd2, d1E4, d2E4

def true_call(S,K,vol,Tsec):
    t=Tsec/31536000.0
    if t<=0 or vol<=0: return max(S-K,0)
    d1=(math.log(S/K)+0.5*vol*vol*t)/(vol*math.sqrt(t))
    d2=d1-vol*math.sqrt(t)
    N=lambda x:0.5*(1+math.erf(x/math.sqrt(2)))
    return S*N(d1)-K*N(d2)

S=200*10**8
vols=[int(0.2e8),int(0.5e8),int(0.8e8),int(1.0e8),int(1.5e8),int(3e8)]
Ts=[5,60,3600,86400,7*86400,30*86400,84*86400]
flags=[]
tested=0; reverts=0
for vol in vols:
    for T in Ts:
        for ratio_pct in range(1,2000):
            # K/S ratio log-ish: use ratio_pct/200 => 0.005..10 plus extremes below
            K=int(S*ratio_pct/200)+1
            try:
                price,nd1,nd2,d1,d2=calcCall(S,K,vol,T)
            except Exception as e:
                reverts+=1; continue
            tested+=1
            tc=true_call(S,K,vol/1e8,T)
            if price>S or price<0 or nd1<0 or nd1>10**8 or nd2<0 or nd2>10**8:
                flags.append(('BOUND',S,K,vol,T,price,nd1,nd2,tc))
            elif price>tc*1.10 and price-tc>S*0.005:
                flags.append(('OVER>10%',S,K,vol,T,price,nd1,nd2,tc))
            elif price<tc*0.90 and tc-price>S*0.005:
                flags.append(('UNDER>10%',S,K,vol,T,price,nd1,nd2,tc))
# extremes strikes
for K in [1,10,100,1000,10**5,10**6,10**7,10**8,10**9,10**10,10**11,10**12,10**13-1]:
    for vol in vols:
        for T in Ts+[1,2,3,10,100,1000]:
            try:
                price,nd1,nd2,d1,d2=calcCall(S,K,vol,T)
            except Exception:
                reverts+=1; continue
            tested+=1
            tc=true_call(S,K,vol/1e8,T)
            if price>S or price<0 or nd1<0 or nd1>10**8 or nd2<0 or nd2>10**8:
                flags.append(('BOUND-EXT',S,K,vol,T,price,nd1,nd2,tc))
            elif (tc>0 and price>tc*1.20 and price-tc>S*0.002) or (tc==0 and price>S*0.002):
                flags.append(('OVER20-EXT',S,K,vol,T,price,nd1,nd2,tc))

print(f"tested={tested} reverts={reverts} flags={len(flags)}")
for f in flags[:60]:
    print(f)
