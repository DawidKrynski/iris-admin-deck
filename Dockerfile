ARG IMAGE=intersystemsdc/iris-community:2026.2-zpm
FROM $IMAGE

WORKDIR /home/irisowner/dev

ARG TESTS=0
# 1 = seed demo data (certificates, wallet, limited user) through the SysAdmin API
ARG DEMO=1
ARG MODULE="iris-admin-deck"
ARG NAMESPACE="USER"

ENV IRISUSERNAME="_SYSTEM"
ENV IRISPASSWORD="SYS"
ENV IRISNAMESPACE=$NAMESPACE

RUN --mount=type=bind,src=.,dst=. \
    iris start IRIS && \
    iris session IRIS < iris.script && \
    ([ $DEMO -eq 0 ] || python3 scripts/demo_seed.py http://localhost:52773) && \
    ([ $TESTS -eq 0 ] || iris session IRIS -U $NAMESPACE "##class(%ZPM.PackageManager).Shell(\"test $MODULE -v -only\",1,1)") && \
    iris stop IRIS quietly && \
    # Everything the image's first-start hook would set up (namespace, CallIn) is done here;
    # mark it initialised so the hook does not run on first container start.
    date > $ISC_PACKAGE_INSTALLDIR/iris.init

COPY --chmod=0755 scripts/on-start.script /opt/admindeck/on-start.script

# After every start: the metrics sampler, and the demo incident (see scripts/on-start.script)
CMD ["--check-caps", "false", "--after", "iris session IRIS -U %SYS < /opt/admindeck/on-start.script"]
