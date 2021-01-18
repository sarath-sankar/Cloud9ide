AWS Cloud9 Public
=================

!!! Warning !!!
---------------

Everything in this repository will be visible to everyone in the Internet. Don't put any AWS specific, sensitive or protected code here.


Run standalone mode
-------------------

A one time steps is to install Cloud9 dependencies on your local machine.

    ./install-script.sh

One time steps to build the Cloud9 repository

    brazil-build build

Add the following to your ~/.bashrc

    export USER=whatever-you-want-your-username-to-be
    export AUTH=something-really-secure

Then when you want to run Cloud9

    brazil-build-tool-exec npm run standalone -- -- -w /path/to/your/preferred/workspace/directory

You should see output like this:

    $ brazil-build-tool-exec npm run standalone …
    > @c9/extension-sdk@5.0.0 standalone /workplace/foo/cloud9/src/AWSCloud9Public
    > cd packages/ide && npm run standalone
    > @c9/ide@4.1.0 standalone /workplace/foo/cloud9/src/AWSCloud9Public/packages/ide
    > node server.js standalone -p 8182 -l 0.0.0.0 -k -a $USER:$AUTH --collab
    Starting standalone version 4.1.0/testing in mode "standalone"
    CDN: version standalone initialized /workplace/foo/cloud9/src/AWSCloud9Public/packages/ide/build
    Started /workplace/foo/cloud9/src/AWSCloud9Public/packages/ide/configs/standalone with config standalone!
    Cloud9 is up and running
    Node version:  v12.16.1
    Connect server listening at http://172.22.71.221:8182

### Run standalone with custom args

The entrypoint for standalone is `./packages/ide/server.js`.  You can run it
directly if you want more control. Options are listed in the file source, or
its `--help`:

    brazil-build-tool-exec node ./packages/ide/server.js --help

For example to specify the `--setting-path` directory you could start
standalone like this:

    cd ./packages/ide/ && brazil-build-tool-exec node server.js standalone -k --port 8182 -l 0.0.0.0 --auth testuser:testpw --collab --setting-path foo

Syncing code between Brazil and Github
--------------------------------------

See https://quip-amazon.com/ZZtzAqCa5aK4 to understand how changes will be synchronized between Brazil and Github.

